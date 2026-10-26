import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { ModelPoolModel, VirtualApiKeyModel } from "@/models";
import { accessGrants, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import modelRouterRoutes from "./model-router";

// Model pools are a beta feature; these tests run with it on.
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

// One model on two providers: Z.ai answers on the OpenAI wire and Bedrock on
// Converse. The caller's virtual key holds neither key; the pool granted to it
// is enough. Only the HTTP upstreams are mocked.
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
setupTestCacheManager();
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const zaiOrigin = "https://zai.example.test/api/paas/v4";
const bedrockOrigin = "https://bedrock.example.test";

const poolTest = test.extend<{
  router: {
    app: FastifyInstanceWithZod;
    agentId: string;
    token: string;
    /** A virtual key in the same org that maps no member key and has no grant. */
    ungrantedToken: string;
    /** A virtual key that maps a member's key, as a Connect key does. */
    memberKeyToken: string;
    poolId: string;
    zaiKeyId: string;
    bedrockKeyId: string;
  };
}>({
  router: async (
    { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey },
    use,
  ) => {
    config.llm.bedrock.baseUrl = bedrockOrigin;
    config.llm.bedrock.iamAuthEnabled = false;
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const zai = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "zai-key" } })).id,
      { provider: "zhipuai", baseUrl: zaiOrigin },
    );
    const bedrock = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "bedrock-bearer" } })).id,
      { provider: "bedrock" },
    );
    const openai = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "sk-unused" } })).id,
      { provider: "openai" },
    );
    const virtual = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "OpenAI-only router key",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "openai", providerApiKeyId: openai.id }],
    });
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "glm-5",
        members: [
          {
            providerApiKeyId: zai.id,
            modelId: "glm-5",
            priority: 1,
            weight: 1,
            enabled: true,
          },
          {
            providerApiKeyId: bedrock.id,
            modelId: "zai.glm-5",
            priority: 2,
            weight: 1,
            enabled: true,
          },
        ],
        virtualApiKeyIds: [virtual.virtualKey.id],
      },
    });
    const ungranted = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Router key without the pool",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "openai", providerApiKeyId: openai.id }],
    });
    const memberKey = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Connect key",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "zhipuai", providerApiKeyId: zai.id }],
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    try {
      await use({
        app,
        agentId: agent.id,
        token: virtual.value,
        ungrantedToken: ungranted.value,
        memberKeyToken: memberKey.value,
        poolId: pool.id,
        zaiKeyId: zai.id,
        bedrockKeyId: bedrock.id,
      });
    } finally {
      await app.close();
    }
  },
});

poolTest("lists the pool's name first", async ({ router }) => {
  const response = await router.app.inject({
    method: "GET",
    url: `/v1/model-router/${router.agentId}/models`,
    headers: { authorization: `Bearer ${router.token}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data[0]).toMatchObject({
    id: "glm-5",
    owned_by: "model-pool",
  });
});

poolTest(
  "keeps the pool from a virtual key it isn't granted to",
  async ({ router }) => {
    let zaiCalls = 0;
    server.use(
      http.post(`${zaiOrigin}/chat/completions`, () => {
        zaiCalls++;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    const models = await router.app.inject({
      method: "GET",
      url: `/v1/model-router/${router.agentId}/models`,
      headers: { authorization: `Bearer ${router.ungrantedToken}` },
    });
    expect(models.statusCode, models.body).toBe(200);
    expect(
      models
        .json()
        .data.filter((m: { owned_by: string }) => m.owned_by === "model-pool"),
    ).toEqual([]);

    // Asking for the pool's name doesn't reach it.
    const response = await router.app.inject({
      method: "POST",
      url: `/v1/model-router/${router.agentId}/chat/completions`,
      headers: { authorization: `Bearer ${router.ungrantedToken}` },
      payload: {
        model: "glm-5",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.headers["x-archestra-pool"]).toBeUndefined();
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(zaiCalls).toBe(0);
  },
);

poolTest(
  "serves the pool to a virtual key that maps a member's key",
  async ({ router }) => {
    server.use(
      http.post(`${zaiOrigin}/chat/completions`, () =>
        HttpResponse.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
      ),
    );
    const models = await router.app.inject({
      method: "GET",
      url: `/v1/model-router/${router.agentId}/models`,
      headers: { authorization: `Bearer ${router.memberKeyToken}` },
    });
    expect(models.json().data[0]).toMatchObject({
      id: "glm-5",
      owned_by: "model-pool",
    });

    const response = await router.app.inject({
      method: "POST",
      url: `/v1/model-router/${router.agentId}/chat/completions`,
      headers: { authorization: `Bearer ${router.memberKeyToken}` },
      payload: {
        model: "glm-5",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-archestra-pool"]).toBe("glm-5");
  },
);

for (const stream of [false, true]) {
  poolTest(
    `fails over from Z.ai to Bedrock by the pool's name (stream: ${stream})`,
    async ({ router }) => {
      let zaiCalls = 0;
      let bedrockModel: string | undefined;
      server.use(
        http.post(`${zaiOrigin}/chat/completions`, () => {
          zaiCalls++;
          return HttpResponse.json(
            { error: { message: "Rate limit reached", code: "1302" } },
            { status: 429, headers: { "retry-after": "20" } },
          );
        }),
        http.post(
          `${bedrockOrigin}/model/:model/${stream ? "converse-stream" : "converse"}`,
          ({ params }) => {
            bedrockModel = decodeURIComponent(String(params.model));
            const usage = { inputTokens: 9, outputTokens: 2, totalTokens: 11 };
            if (!stream) {
              return HttpResponse.json({
                output: {
                  message: { role: "assistant", content: [{ text: "hi" }] },
                },
                stopReason: "end_turn",
                usage,
              });
            }
            return new HttpResponse(
              binaryEvents([
                ["messageStart", { role: "assistant" }],
                [
                  "contentBlockDelta",
                  { contentBlockIndex: 0, delta: { text: "hi" } },
                ],
                ["contentBlockStop", { contentBlockIndex: 0 }],
                ["messageStop", { stopReason: "end_turn" }],
                ["metadata", { usage, metrics: { latencyMs: 1 } }],
              ]),
              {
                headers: {
                  "content-type": "application/vnd.amazon.eventstream",
                },
              },
            );
          },
        ),
      );

      const response = await router.app.inject({
        method: "POST",
        url: `/v1/model-router/${router.agentId}/chat/completions`,
        headers: { authorization: `Bearer ${router.token}` },
        payload: {
          model: "glm-5",
          stream,
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(zaiCalls).toBeGreaterThan(0);
      expect(bedrockModel).toBe("zai.glm-5");
      expect(response.headers["x-archestra-pool"]).toBe("glm-5");
      expect(response.headers["x-archestra-attempts"]).toBe("2");
      expect(response.headers["x-archestra-provider-key"]).toBe(
        router.bedrockKeyId,
      );
      const text = stream
        ? response.body
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)))
            .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
            .join("")
        : response.json().choices[0].message.content;
      expect(text).toBe("hi");

      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .orderBy(schema.interactionsTable.attempt);
      expect(
        rows.map((row) => ({
          providerApiKeyId: row.providerApiKeyId,
          modelPoolId: row.modelPoolId,
          model: row.model,
          attemptOutcome: row.attemptOutcome,
        })),
      ).toEqual([
        {
          providerApiKeyId: router.zaiKeyId,
          modelPoolId: router.poolId,
          model: "glm-5",
          attemptOutcome: "failed_over",
        },
        {
          providerApiKeyId: router.bedrockKeyId,
          modelPoolId: router.poolId,
          model: "zai.glm-5",
          attemptOutcome: "answered",
        },
      ]);
    },
  );
}

function binaryEvents(events: Array<[string, unknown]>): Uint8Array {
  const parts = events.map(([type, body]) =>
    codec.encode({
      headers: {
        ":event-type": { type: "string", value: type },
        ":content-type": { type: "string", value: "application/json" },
        ":message-type": { type: "string", value: "event" },
      },
      body: fromUtf8(JSON.stringify(body)),
    }),
  );
  const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
