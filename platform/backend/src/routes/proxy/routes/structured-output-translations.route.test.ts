import { HttpResponse, http } from "msw";
import { createFastifyInstance } from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import bedrockOpenaiRoutes from "./bedrock-openai";
import modelRouterRoutes from "./model-router";

setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper, not a React hook.
const server = useMswServer();

for (const stream of [false, true]) {
  test.for([
    { provider: "anthropic" as const, modelId: "claude-opus-4-6-20250918" },
    { provider: "bedrock" as const, modelId: "amazon.nova-pro-v1:0" },
    { provider: "cohere" as const, modelId: "command-a-03-2025" },
    { provider: "gemini" as const, modelId: "gemini-2.5-pro" },
  ])(`rejects unsupported $provider structured output before upstream (stream: ${stream})`, async ({
    provider,
    modelId,
  }, { makeAgent, makeSecret, makeLlmProviderApiKey }) => {
    let upstreamCalls = 0;
    server.use(
      http.all("*", () => {
        upstreamCalls++;
        return HttpResponse.json(
          { error: "Unexpected upstream call" },
          { status: 502 },
        );
      }),
    );
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const model = await ModelModel.upsert({
      externalId: `${provider}/${modelId}`,
      provider,
      modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
      lastSyncedAt: new Date(),
    });
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const key = await makeLlmProviderApiKey(agent.organizationId, secret.id, {
      provider,
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const { value } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Structured translation test",
      providerApiKeys: [{ provider, providerApiKeyId: key.id }],
    });
    const app = createFastifyInstance();
    try {
      await app.register(modelRouterRoutes);
      await app.register(bedrockOpenaiRoutes);
      const urls = [
        "/v1/model-router/chat/completions",
        `/v1/model-router/${agent.id}/chat/completions`,
      ];
      if (provider === "bedrock")
        urls.push(
          "/v1/bedrock/openai/chat/completions",
          `/v1/bedrock/openai/${agent.id}/chat/completions`,
        );
      for (const url of urls) {
        for (const format of [
          { type: "json_object" },
          {
            type: "json_schema",
            json_schema: {
              name: "status_result",
              strict: true,
              schema: {
                type: "object",
                properties: { status: { type: "string" } },
                required: ["status"],
                additionalProperties: false,
              },
            },
          },
        ]) {
          const response = await app.inject({
            method: "POST",
            url,
            headers: { authorization: `Bearer ${value}` },
            payload: {
              model: url.includes("model-router")
                ? `${provider}:${modelId}`
                : modelId,
              messages: [{ role: "user", content: "Reply OK." }],
              response_format: format,
              stream,
            },
          });
          expect(response.statusCode, response.body).toBe(400);
          expect(response.json().error.message).toContain("response_format");
        }
      }
      expect(upstreamCalls).toBe(0);
    } finally {
      await app.close();
    }
  });
}
