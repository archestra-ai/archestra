import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import {
  InteractionModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { accessGrants, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import modelRouterRoutes from "./model-router";

// The real route, credentials selection, adapter, client and logging execute.
// Only the HTTP upstream is mocked; unmatched network requests fail the test.
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const modelId = "application-profile-placeholder";
const cache_control = { type: "ephemeral" };
const checkpoint = { cachePoint: { type: "default" } };
const upstreamOrigin = "https://bedrock.example.test";

const bedrockTest = test.extend<{
  router: { app: FastifyInstanceWithZod; agentId: string; token: string };
}>({
  router: async (
    { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey },
    use,
  ) => {
    config.llm.bedrock.baseUrl = upstreamOrigin;
    config.llm.bedrock.iamAuthEnabled = false;
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const model = await ModelModel.upsert({
      externalId: `bedrock/${modelId}`,
      provider: "bedrock",
      modelId,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      lastSyncedAt: new Date(),
    });
    const secret = await makeSecret({
      secret: { apiKey: "test-bedrock-bearer" },
    });
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "bedrock",
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const virtual = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Mocked Bedrock router",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "bedrock", providerApiKeyId: key.id }],
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    try {
      await use({ app, agentId: agent.id, token: virtual.value });
    } finally {
      await app.close();
    }
  },
});

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

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
}

for (const stream of [false, true]) {
  bedrockTest(
    `Responses, stream=${stream}: preserves checkpoints, returned cache usage and logging`,
    async ({ router }) => {
      const reads = 8000;
      const writes = 1000;
      const usage = {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15 + reads + writes,
        cacheReadInputTokens: reads,
        cacheWriteInputTokens: writes,
        cacheDetails: [{ ttl: "1h", inputTokens: writes }],
      };
      let upstream: Record<string, unknown> | undefined;
      server.use(
        http.post(
          `${upstreamOrigin}/model/:model/${stream ? "converse-stream" : "converse"}`,
          async ({ request }) => {
            upstream = (await request.json()) as Record<string, unknown>;
            if (!stream)
              return HttpResponse.json({
                output: {
                  message: {
                    role: "assistant",
                    content: [{ text: "answer" }],
                  },
                },
                stopReason: "end_turn",
                usage,
              });
            return new HttpResponse(
              binaryEvents([
                ["messageStart", { role: "assistant" }],
                [
                  "contentBlockDelta",
                  { contentBlockIndex: 0, delta: { text: "answer" } },
                ],
                ["contentBlockStop", { contentBlockIndex: 0 }],
                ["messageStop", { stopReason: "end_turn" }],
                ["metadata", { usage }],
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
      const payload = {
        model: `bedrock:${modelId}`,
        stream,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "prefix", cache_control }],
          },
        ],
      };
      const url = `/v1/model-router/${router.agentId}/responses`;
      const response = await router.app.inject({
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${router.token}`,
          "user-agent": "test-client",
        },
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(upstream?.messages).toEqual([
        { role: "user", content: [{ text: "prefix" }, checkpoint] },
      ]);
      const wire = !stream
        ? response.json().usage
        : (
            sseEvents(response.body).find(
              (e) => e.type === "response.completed",
            )?.response as { usage: unknown }
          ).usage;
      expect(wire).toMatchObject({
        input_tokens: 12 + reads + writes,
        total_tokens: 15 + reads + writes,
        input_tokens_details: {
          cached_tokens: reads,
          cache_write_tokens: writes,
          cache_write_1h_tokens: writes,
        },
      });
      const logged = await InteractionModel.findAllPaginated({
        limit: 1,
        offset: 0,
      });
      expect(logged.data[0]).toMatchObject({
        type: "bedrock:converse",
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: reads,
        cacheWriteTokens: writes,
      });
      const { totalTokens: _totalTokens, ...loggedUsage } = usage;
      expect(logged.data[0].response).toMatchObject({ usage: loggedUsage });
    },
  );
}

bedrockTest(
  "Responses mixed files, images and a growing tool transcript retain their order at the real HTTP boundary",
  async ({ router }) => {
    const captured: Record<string, unknown>[] = [];
    server.use(
      http.post(
        `${upstreamOrigin}/model/:model/converse`,
        async ({ request }) => {
          captured.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({
            output: {
              message: { role: "assistant", content: [{ text: "ok" }] },
            },
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 2 },
          });
        },
      ),
    );
    const first = {
      role: "user",
      content: [
        { type: "input_text", text: "prefix", cache_control },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        { type: "input_file", file_data: "data:application/pdf;base64,cGRm" },
        {
          type: "input_file",
          file_data: "data:application/json;base64,e30=",
          cache_control,
        },
        { type: "input_text", text: "question" },
      ],
    };
    for (const result of ["tool result", "tool result plus more content"]) {
      const response = await router.app.inject({
        method: "POST",
        url: `/v1/model-router/${router.agentId}/responses`,
        headers: { authorization: `Bearer ${router.token}` },
        payload: {
          model: `bedrock:${modelId}`,
          input: [
            first,
            {
              type: "function_call",
              call_id: "call_1",
              name: "read_file",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_1",
              output: result,
              cache_control,
            },
          ],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(captured.at(-1)?.messages).toEqual([
        {
          role: "user",
          content: [
            { text: "prefix" },
            checkpoint,
            { image: { format: "png", source: { bytes: "aGVsbG8=" } } },
            {
              document: {
                format: "pdf",
                name: "document",
                source: { bytes: "cGRm" },
              },
            },
            {
              document: {
                format: "txt",
                name: "document",
                source: { bytes: "e30=" },
              },
            },
            checkpoint,
            { text: "question" },
          ],
        },
        {
          role: "assistant",
          content: [
            { toolUse: { toolUseId: "call_1", name: "read_file", input: {} } },
          ],
        },
        {
          role: "user",
          content: [
            {
              toolResult: { toolUseId: "call_1", content: [{ text: result }] },
            },
            checkpoint,
          ],
        },
      ]);
    }
  },
);

bedrockTest(
  "rejects unresolved files before making an upstream HTTP request",
  async ({ router }) => {
    const response = await router.app.inject({
      method: "POST",
      url: `/v1/model-router/${router.agentId}/responses`,
      headers: { authorization: `Bearer ${router.token}` },
      payload: {
        model: `bedrock:${modelId}`,
        input: [
          {
            role: "user",
            content: [{ type: "input_file", file_id: "file_unresolved" }],
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message).toContain("cannot be resolved");
  },
);
