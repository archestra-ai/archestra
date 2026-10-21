import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import InteractionModel from "@/models/interaction";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { accessGrants, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import routes from "./model-router";

setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper
const server = useMswServer();

for (const stream of [false, true]) {
  test(`records the selected LiteLLM instance's cost through the real proxy, stream=${stream}`, async ({
    makeOrganization,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    config.llmProxy.usageAccountingMode = "off";
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const model = await ModelModel.create({
      externalId: "openai/team-chat",
      modelId: "team-chat",
      provider: "openai",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const app = createFastifyInstance();
    await app.register(routes);
    try {
      for (const [instance, input, expected] of [
        ["a", "0.000002", 0.0062],
        ["b", "0.000004", 0.0082],
      ] as const) {
        const baseUrl = `https://${instance}.example.test/gateway/v1`;
        const secret = await makeSecret({
          secret: { apiKey: `fixture-${instance}` },
        });
        const key = await makeLlmProviderApiKey(org.id, secret.id, {
          provider: "openai",
          baseUrl,
        });
        await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
          key.id,
          [
            {
              id: model.id,
              modelId: model.modelId,
              providerPricing: {
                promptPricePerToken: input,
                completionPricePerToken: "0.000008",
                cacheReadPricePerToken: "0.0000005",
                cacheWritePricePerToken: null,
              },
            },
          ],
          "openai",
        );
        const virtual = await VirtualApiKeyModel.create({
          organizationId: org.id,
          name: `Fixture ${instance}`,
          ...accessGrants("org"),
          providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
        });
        const usage = {
          prompt_tokens: 1400,
          completion_tokens: 500,
          total_tokens: 1900,
          prompt_tokens_details: { cached_tokens: 400 },
        };
        const respond = async ({ request }: { request: Request }) => {
          expect(request.headers.get("authorization")).toBe(
            `Bearer fixture-${instance}`,
          );
          const body = (await request.json()) as {
            model: string;
            stream?: boolean;
          };
          expect(body.model).toBe("team-chat");
          if (!body.stream)
            return HttpResponse.json({
              id: "fixture",
              object: "chat.completion",
              created: 1,
              model: "team-chat",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Fixture answer" },
                  finish_reason: "stop",
                },
              ],
              usage,
            });
          const events = [
            {
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Fixture answer" },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            { choices: [], usage },
          ]
            .map(
              (event) =>
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "upstream-vendor-model", ...event })}\n\n`,
            )
            .join("");
          return new HttpResponse(`${events}data: [DONE]\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        };
        server.use(http.post(`${baseUrl}/chat/completions`, respond));
        // Return the finite stream directly at the fetch boundary. MSW's
        // response cloning can leave an SDK SSE reader waiting after EOF.
        if (stream)
          vi.stubGlobal(
            "fetch",
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const request = new Request(input, init);
              expect(request.url).toBe(`${baseUrl}/chat/completions`);
              return respond({ request });
            },
          );
        const response = await app.inject({
          method: "POST",
          url: `/v1/model-router/${agent.id}/chat/completions`,
          headers: { authorization: `Bearer ${virtual.value}` },
          payload: {
            model: "openai:team-chat",
            messages: [{ role: "user", content: "Fixture request" }],
            stream,
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        const logged = await InteractionModel.findAllPaginated({
          limit: 1,
          offset: 0,
        });
        expect(logged.data[0]).toMatchObject({
          model: "team-chat",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 400,
        });
        expect(Number(logged.data[0].cost)).toBeCloseTo(expected, 10);
      }
    } finally {
      await app.close();
    }
  });
}
