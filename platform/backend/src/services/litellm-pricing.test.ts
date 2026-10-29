import { HttpResponse, http } from "msw";
import { modelsDevClient } from "@/clients/models-dev-client";
import InteractionModel from "@/models/interaction";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import StatisticsModel from "@/models/statistics";
import { fetchOpenAiModels } from "@/routes/chat/model-fetchers/openai";
import {
  buildInteractionRecord,
  calculateInteractionCosts,
} from "@/routes/proxy/llm-proxy-helpers";
import { afterEach, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { modelSyncService } from "./model-sync";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper
const server = useMswServer(
  http.get("https://models.dev/api.json", () => HttpResponse.json({})),
);
afterEach(() => modelsDevClient.clearFetchCache());

test("syncs LiteLLM alias prices and uses the selected instance for accounting", async ({
  makeOrganization,
  makeSecret,
  makeLlmProviderApiKey,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const secret = await makeSecret({ secret: { apiKey: "fixture-key" } });
  const keys = [];
  for (const [instance, input] of [
    ["a", 0.000002],
    ["b", 0.000004],
  ] as const) {
    const baseUrl = `https://${instance}.example.test/gateway/v1/`;
    server.use(
      http.get(`${baseUrl}models`, () =>
        HttpResponse.json({
          data: [
            {
              id: "team-chat",
              object: "model",
              owned_by: "litellm",
              created: 1,
            },
          ],
        }),
      ),
      http.get(`${baseUrl}model/info`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer fixture-key");
        expect(request.headers.get("x-fixture")).toBe("pricing");
        return HttpResponse.json({
          data: [
            {
              model_name: "team-chat",
              model_info: {
                input_cost_per_token: input,
                output_cost_per_token: 0.000008,
                cache_read_input_token_cost: 0.0000005,
                cache_creation_input_token_cost: 0.000003,
              },
            },
          ],
        });
      }),
    );
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      baseUrl,
    });
    keys.push(key);
    const models = await fetchOpenAiModels("fixture-key", baseUrl, {
      "x-fixture": "pricing",
    });
    expect(models[0]).toMatchObject({
      id: "team-chat",
      providerPricing: {
        promptPricePerToken: String(input),
        completionPricePerToken: "0.000008",
      },
    });
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: key.id,
      provider: "openai",
      apiKeyValue: "fixture-key",
      baseUrl,
      extraHeaders: { "x-fixture": "pricing" },
    });
  }
  const [a, b] = keys;
  const [listed] = await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([
    a.id,
  ]);
  expect(ModelModel.toCapabilities(listed.model)).toMatchObject({
    pricePerMillionInput: "2",
    pricePerMillionOutput: "8",
    priceSource: "provider",
    pricePerMillionCacheRead: "0.5",
    pricePerMillionCacheWrite: "3",
  });
  // Global catalog prices must not acquire either endpoint's private rate.
  expect(
    (await ModelModel.findByProviderAndModelId("openai", "team-chat"))
      ?.promptPricePerToken,
  ).toBeNull();
  for (const [key, expected] of [
    [a, 0.0074],
    [b, 0.0094],
  ] as const) {
    for (const mode of ["off", "enforce"] as const) {
      const costs = await calculateInteractionCosts({
        actualModel: "team-chat",
        providerName: "openai",
        providerApiKeyId: key.id,
        usageAccountingMode: mode,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 400,
          cacheWriteTokens: 400,
        },
      });
      expect(costs.actualCost).toBeCloseTo(expected, 10);
      const saved = await InteractionModel.create(
        buildInteractionRecord({
          agent,
          actualModel: "team-chat",
          providerType: "openai:chatCompletions",
          billingMode: "metered",
          billingAttribution: {
            organizationId: org.id,
            environmentId: agent.environmentId,
            entities: [
              { entityType: "organization", entityId: org.id },
              { entityType: "agent", entityId: agent.id },
            ],
          },
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 400,
            cacheWriteTokens: 400,
          },
          request: { model: "team-chat", messages: [] },
          processedRequest: null,
          response: {
            id: "fixture",
            model: "team-chat",
            choices: [],
            object: "chat.completion",
            created: 1,
          },
          costs,
        }),
      );
      expect(Number(saved.cost)).toBeCloseTo(expected, 10);
    }
  }
  const stats = await StatisticsModel.getCostSavingsStatistics({
    organizationId: org.id,
    timeframe: "24h",
  });
  expect(stats.totalActualCost).toBeCloseTo(0.0336, 10);
});

test("refreshes instance rates while preserving overrides, zero and unknown prices", async ({
  makeOrganization,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const org = await makeOrganization();
  const secret = await makeSecret({ secret: { apiKey: "fixture-key" } });
  const baseUrl = "https://refresh.example.test/v1";
  const key = await makeLlmProviderApiKey(org.id, secret.id, {
    provider: "openai",
    baseUrl,
  });
  let info: Record<string, unknown> = {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000008,
  };
  server.use(
    http.get(`${baseUrl}/models`, () =>
      HttpResponse.json({
        data: [
          { id: "alias", object: "model", owned_by: "litellm", created: 1 },
        ],
      }),
    ),
    http.get(`${baseUrl}/model/info`, () =>
      HttpResponse.json({ data: [{ model_name: "alias", model_info: info }] }),
    ),
  );
  const sync = (forceRefresh = false) =>
    modelSyncService.syncModelsForApiKey({
      apiKeyId: key.id,
      provider: "openai",
      apiKeyValue: "fixture-key",
      baseUrl,
      forceRefresh,
    });
  const projected = () =>
    LlmProviderApiKeyModelLinkModel.findModelForPricing({
      apiKeyId: key.id,
      provider: "openai",
      modelId: "alias",
    });
  await sync();
  const initial = await projected();
  expect(initial).not.toBeNull();
  await ModelModel.update(initial?.id ?? "", {
    customPricePerMillionInput: "7",
    customPricePerMillionOutput: "9",
  });
  info = {
    input_cost_per_token: 0,
    output_cost_per_token: 0,
    cache_read_input_token_cost: 0,
  };
  await sync();
  expect(ModelModel.toCapabilities(await projected())).toMatchObject({
    pricePerMillionInput: "7.00",
    pricePerMillionOutput: "9.00",
    priceSource: "custom",
    pricePerMillionCacheRead: "0",
    pricePerMillionCacheWrite: null,
  });
  await sync(true);
  expect(ModelModel.toCapabilities(await projected())).toMatchObject({
    pricePerMillionInput: "0",
    pricePerMillionOutput: "0",
    priceSource: "provider",
    pricePerMillionCacheRead: "0",
    pricePerMillionCacheWrite: null,
  });
  const zero = await calculateInteractionCosts({
    actualModel: "alias",
    providerName: "openai",
    providerApiKeyId: key.id,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100 },
  });
  expect(zero.actualCost).toBe(0);

  info = { output_cost_per_token: 0.000008 };
  await sync();
  expect(ModelModel.toCapabilities(await projected())).toMatchObject({
    pricePerMillionInput: null,
    pricePerMillionOutput: "8",
    pricePerMillionCacheRead: null,
    pricePerMillionCacheWrite: null,
  });
  const missing = {
    actualModel: "alias",
    providerName: "openai" as const,
    providerApiKeyId: key.id,
    usage: { inputTokens: 1000, outputTokens: 500 },
  };
  expect((await calculateInteractionCosts(missing)).actualCost).toBeUndefined();
  const enforced = await calculateInteractionCosts({
    ...missing,
    usageAccountingMode: "enforce",
  });
  expect(enforced.billingUsage).toMatchObject({
    status: "incomplete",
    issues: ["unpriced_usage"],
    components: [{ prices: { input: null, output: "8" } }],
  });
});
