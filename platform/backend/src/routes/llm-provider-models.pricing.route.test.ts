import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./llm-provider-models";

setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper
const ctx = useRouteTestApp(routes);

test("Models API displays the selected instance and leaves conflicting merged rates unknown", async ({
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const secret = await makeSecret({ secret: { apiKey: "fixture-key" } });
  const model = await ModelModel.create({
    externalId: "openai/team-chat",
    provider: "openai",
    modelId: "team-chat",
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  const keys = [];
  for (const input of ["0.000002", "0.000004"]) {
    const key = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
      provider: "openai",
      name: `Fixture ${keys.length + 1}`,
    });
    keys.push(key);
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
            cacheWritePricePerToken: "0.000003",
          },
        },
      ],
      "openai",
    );
  }
  const selected = await ctx.app.inject({
    method: "GET",
    url: `/api/llm-models?apiKeyIds=${keys[0].id}&includeAssignments=false`,
  });
  expect(selected.statusCode, selected.body).toBe(200);
  expect(selected.json()).toEqual([
    expect.objectContaining({
      modelId: "team-chat",
      pricePerMillionInput: "2",
      pricePerMillionOutput: "8",
      priceSource: "provider",
      pricePerMillionCacheRead: "0.5",
      pricePerMillionCacheWrite: "3",
      isFree: false,
    }),
  ]);
  const merged = await ctx.app.inject({
    method: "GET",
    url: "/api/llm-models?includeAssignments=false",
  });
  expect(merged.statusCode, merged.body).toBe(200);
  expect(merged.json()).toEqual([
    expect.objectContaining({
      modelId: "team-chat",
      pricePerMillionInput: null,
      pricePerMillionOutput: null,
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      isFree: false,
    }),
  ]);
});
