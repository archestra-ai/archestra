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

test("Models API accepts long-context pricing only as a complete, positive set", async ({
  makeMember,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const model = await ModelModel.create({
    externalId: "anthropic/long-context",
    provider: "anthropic",
    modelId: "long-context",
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  const url = `/api/llm-models/${model.id}`;
  const complete = {
    longContextThreshold: 200000,
    longContextPricePerMillionInput: "6",
    longContextPricePerMillionOutput: "22.5",
    longContextPricePerMillionCacheRead: "0.6",
    longContextPricePerMillionCacheWrite: "7.5",
  };
  for (const invalid of [
    { ...complete, longContextThreshold: 0 },
    { ...complete, longContextThreshold: 1.5 },
    { ...complete, longContextPricePerMillionOutput: null },
    { longContextThreshold: 200000 },
    { ...complete, longContextPricePerMillionCacheRead: "1usd" },
  ]) {
    const response = await ctx.app.inject({
      method: "PATCH",
      url,
      payload: invalid,
    });
    expect(response.statusCode, JSON.stringify(invalid)).toBe(400);
  }
  expect(await ModelModel.findById(model.id)).toMatchObject({
    longContextThreshold: null,
    longContextPricePerMillionInput: null,
  });

  const saved = await ctx.app.inject({
    method: "PATCH",
    url,
    payload: complete,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json()).toMatchObject({
    longContextThreshold: 200000,
    longContextPricePerMillionInput: "6.00000000",
    longContextPricePerMillionOutput: "22.50000000",
    longContextPricePerMillionCacheRead: "0.60000000",
    longContextPricePerMillionCacheWrite: "7.50000000",
  });

  const cleared = await ctx.app.inject({
    method: "PATCH",
    url,
    payload: Object.fromEntries(
      Object.keys(complete).map((key) => [key, null]),
    ),
  });
  expect(cleared.statusCode, cleared.body).toBe(200);
  expect(await ModelModel.findById(model.id)).toMatchObject({
    longContextThreshold: null,
    longContextPricePerMillionCacheWrite: null,
  });
});

test("Models API preserves all eight decimal custom and long-context rates", async ({
  makeMember,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const model = await ModelModel.create({
    externalId: "anthropic/precise-pricing",
    provider: "anthropic",
    modelId: "precise-pricing",
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  const prices = {
    customPricePerMillionInput: "0.00000001",
    customPricePerMillionOutput: "0.12345678",
    customPricePerMillionCacheRead: "0.00000002",
    customPricePerMillionCacheWrite: "99999999.98999999",
    longContextThreshold: 200000,
    longContextPricePerMillionInput: "0.00000003",
    longContextPricePerMillionOutput: "0.23456789",
    longContextPricePerMillionCacheRead: "0.00000004",
    longContextPricePerMillionCacheWrite: "1.23456789",
  };
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/llm-models/${model.id}`,
    payload: prices,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject(prices);
  expect(await ModelModel.findById(model.id)).toMatchObject(prices);
});
