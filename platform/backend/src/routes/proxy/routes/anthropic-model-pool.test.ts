import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelPoolModel, VirtualApiKeyModel } from "@/models";
import { beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import anthropicProxyRoutes from "./anthropic";

// Model pools are a beta feature; these tests run with it on.
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

// Claude Code asks for a pool's name on Anthropic's wire; the pool's only
// member is Z.ai on the OpenAI wire. The virtual key maps no Anthropic key:
// mapping the member's key (as a Connect key does) or a grant lets it in.
// Only the HTTP upstream is mocked.
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
setupTestCacheManager();
const zaiOrigin = "https://zai.example.test/api/paas/v4";

for (const [stream, access] of [
  [false, "member key"],
  [true, "member key"],
  [false, "grant"],
] as const) {
  test(`answers an Anthropic request from a Z.ai member (stream: ${stream}, via ${access})`, async ({
    makeOrganization,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const zai = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "zai-key" } })).id,
      { provider: "zhipuai", baseUrl: zaiOrigin },
    );
    const openai = await makeLlmProviderApiKey(org.id, null);
    const { value, virtualKey } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Claude Code",
      providerApiKeys:
        access === "grant"
          ? [{ provider: "openai", providerApiKeyId: openai.id }]
          : [{ provider: "zhipuai", providerApiKeyId: zai.id }],
    });
    await ModelPoolModel.create({
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
        ],
        virtualApiKeyIds: access === "grant" ? [virtualKey.id] : [],
      },
    });

    let upstream: Record<string, unknown> | undefined;
    let authorization: string | null = null;
    server.use(
      http.post(`${zaiOrigin}/chat/completions`, async ({ request }) => {
        upstream = (await request.json()) as Record<string, unknown>;
        authorization = request.headers.get("authorization");
        if (!stream) {
          return HttpResponse.json({
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
          });
        }
        const chunks = [
          {
            choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
          },
          { choices: [{ index: 0, delta: { content: "hi" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          {
            choices: [],
            usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
          },
        ].map((chunk) => ({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "glm-5",
          ...chunk,
        }));
        return new HttpResponse(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(anthropicProxyRoutes);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${agent.id}/v1/messages`,
        headers: {
          authorization: `Bearer ${value}`,
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "glm-5",
          max_tokens: 1024,
          stream,
          system: "Be brief.",
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(authorization).toBe("Bearer zai-key");
      expect(upstream).toMatchObject({
        model: "glm-5",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hello" },
        ],
      });
      expect(response.headers["x-archestra-provider-key"]).toBe(zai.id);
      if (stream) {
        expect(response.body).toContain("event: message_start");
        expect(response.body).toContain('"text":"hi"');
        expect(response.body).toContain("event: message_stop");
      } else {
        expect(response.json()).toMatchObject({
          type: "message",
          role: "assistant",
          model: "glm-5",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 9, output_tokens: 2 },
        });
      }
    } finally {
      await app.close();
    }
  });
}

test("keeps out a virtual key that maps no member key and has no grant", async ({
  makeOrganization,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const zai = await makeLlmProviderApiKey(
    org.id,
    (await makeSecret({ secret: { apiKey: "zai-key" } })).id,
    { provider: "zhipuai", baseUrl: zaiOrigin },
  );
  const openai = await makeLlmProviderApiKey(org.id, null);
  const { value } = await VirtualApiKeyModel.create({
    organizationId: org.id,
    name: "Not granted",
    providerApiKeys: [{ provider: "openai", providerApiKeyId: openai.id }],
  });
  await ModelPoolModel.create({
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
      ],
      virtualApiKeyIds: [],
    },
  });
  let calls = 0;
  server.use(
    http.post(`${zaiOrigin}/chat/completions`, () => {
      calls += 1;
      return HttpResponse.json({});
    }),
  );

  // The real instance, so the central error handler shapes the 400.
  const app = createFastifyInstance();
  await app.register(anthropicProxyRoutes);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        authorization: `Bearer ${value}`,
        "anthropic-version": "2023-06-01",
      },
      payload: {
        model: "glm-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("not mapped to provider");
    expect(calls).toBe(0);
  } finally {
    await app.close();
  }
});
