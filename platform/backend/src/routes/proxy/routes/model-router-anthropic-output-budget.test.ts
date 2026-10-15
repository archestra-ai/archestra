import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { accessGrants, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import modelRouterRoutes from "./model-router";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
const modelId = "claude-thinks-by-default";
const upstreamOrigin = "https://anthropic.example.test";

const anthropicTest = test.extend<{
  router: { app: FastifyInstanceWithZod; agentId: string; token: string };
}>({
  router: async (
    { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey },
    use,
  ) => {
    config.llm.anthropic.baseUrl = upstreamOrigin;
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const model = await ModelModel.upsert({
      externalId: `anthropic/${modelId}`,
      provider: "anthropic",
      modelId,
      outputLength: 128_000,
      contextLength: 1_000_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      lastSyncedAt: new Date(),
    });
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const virtual = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Mocked Anthropic router",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "anthropic", providerApiKeyId: key.id }],
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

async function upstreamMaxTokens(
  router: { app: FastifyInstanceWithZod; agentId: string; token: string },
  cap: Record<string, number>,
): Promise<unknown> {
  let upstream: Record<string, unknown> | undefined;
  server.use(
    http.post(`${upstreamOrigin}/v1/messages`, async ({ request }) => {
      upstream = (await request.json()) as Record<string, unknown>;
      const message = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [{ type: "text", text: "answer" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (upstream.stream !== true) return HttpResponse.json(message);
      // A large max_tokens makes the adapter stream from the upstream.
      const events = [
        { type: "message_start", message: { ...message, content: [] } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "answer" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      return new HttpResponse(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const response = await router.app.inject({
    method: "POST",
    url: `/v1/model-router/${router.agentId}/chat/completions`,
    headers: { authorization: `Bearer ${router.token}` },
    payload: {
      model: `anthropic:${modelId}`,
      messages: [{ role: "user", content: "hi" }],
      ...cap,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return upstream?.max_tokens;
}

anthropicTest(
  "a client that sets no cap gets the model's catalog budget",
  async ({ router }) => {
    expect(await upstreamMaxTokens(router, {})).toBe(
      config.chat.maxOutputTokensCeiling,
    );
  },
);

anthropicTest(
  "a client cap under either OpenAI name reaches Anthropic unchanged",
  async ({ router }) => {
    expect(await upstreamMaxTokens(router, { max_tokens: 1_234 })).toBe(1_234);
    expect(
      await upstreamMaxTokens(router, { max_completion_tokens: 2_345 }),
    ).toBe(2_345);
  },
);
