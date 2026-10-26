import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { describe, expect, test } from "@/test";
import type { CreateModel, UsageView } from "@/types";
import { normalizeAnthropicUsage } from "@/utils/billable-usage";
import {
  buildInteractionRecord,
  calculateInteractionCosts,
} from "./llm-proxy-helpers";

const BASE_PRICES = {
  customPricePerMillionInput: "3",
  customPricePerMillionOutput: "15",
  customPricePerMillionCacheRead: "0.3",
  customPricePerMillionCacheWrite: "3.75",
} satisfies Partial<CreateModel>;

const LONG_PRICES = {
  longContextThreshold: 1000,
  longContextPricePerMillionInput: "6",
  longContextPricePerMillionOutput: "22.5",
  longContextPricePerMillionCacheRead: "0.6",
  longContextPricePerMillionCacheWrite: "7.5",
} satisfies Partial<CreateModel>;

function makeModel(
  modelId: string,
  prices: Partial<CreateModel>,
  provider: CreateModel["provider"] = "anthropic",
) {
  return ModelModel.create({
    provider,
    modelId,
    externalId: `${provider}/${modelId}`,
    inputModalities: ["text"],
    outputModalities: ["text"],
    ...prices,
  });
}

/** Prompt = input + 300 read + 100 write; the 40 1h tokens are part of the writes. */
function mixedUsage(inputTokens: number): UsageView {
  return {
    inputTokens,
    outputTokens: 100,
    cacheReadTokens: 300,
    cacheWriteTokens: 100,
    cacheWrite1hTokens: 40,
  };
}

function costs(
  usage: UsageView,
  actualModel: string,
  extra: Partial<Parameters<typeof calculateInteractionCosts>[0]> = {},
) {
  return calculateInteractionCosts({
    actualModel,
    usage,
    providerName: "anthropic",
    ...extra,
  });
}

function expectAmounts(
  result: Awaited<ReturnType<typeof calculateInteractionCosts>>,
  expected: { actualCost: number; cacheCost: number; cacheSavings: number },
) {
  expect(result.actualCost).toBeCloseTo(expected.actualCost, 10);
  expect(result.cacheCost).toBeCloseTo(expected.cacheCost, 10);
  expect(result.cacheSavings).toBeCloseTo(expected.cacheSavings, 10);
}

describe("calculateInteractionCosts pricing quote", () => {
  test("a prompt at the threshold uses base prices and one token more uses long prices", async () => {
    await makeModel("long-model", { ...BASE_PRICES, ...LONG_PRICES });

    // 600 + 300 + 100 = 1000: the 40 1h writes must not push it over.
    expectAmounts(await costs(mixedUsage(600), "long-model"), {
      // 600*3 + 100*15 + 300*0.3 + 60*3.75 + 40*6 (1h = 1.6x the 5m write)
      actualCost: 0.003855,
      cacheCost: 0.000555,
      cacheSavings: 400 * 3e-6 - 0.000555,
    });
    expectAmounts(await costs(mixedUsage(601), "long-model"), {
      // 601*6 + 100*22.5 + 300*0.6 + 60*7.5 + 40*12
      actualCost: 0.006966,
      cacheCost: 0.00111,
      cacheSavings: 400 * 6e-6 - 0.00111,
    });
  });

  test("ordinary and enforce modes record the same amounts", async () => {
    await makeModel("long-model", { ...BASE_PRICES, ...LONG_PRICES });
    for (const inputTokens of [600, 601]) {
      const ordinary = await costs(mixedUsage(inputTokens), "long-model");
      const enforced = await costs(mixedUsage(inputTokens), "long-model", {
        usageAccountingMode: "enforce",
      });
      expect(enforced.billingUsage?.status).toBe("complete");
      expectAmounts(enforced, {
        actualCost: ordinary.actualCost ?? Number.NaN,
        cacheCost: ordinary.cacheCost ?? Number.NaN,
        cacheSavings: ordinary.cacheSavings ?? Number.NaN,
      });
      expect(enforced.cacheReadSavings).toBeCloseTo(
        ordinary.cacheReadSavings ?? Number.NaN,
        10,
      );
    }
  });

  test("long prices replace the custom rates while the source stays custom", async () => {
    await makeModel("custom-long", {
      ...BASE_PRICES,
      ...LONG_PRICES,
      promptPricePerToken: "0.000001",
      completionPricePerToken: "0.000002",
    });
    const result = await costs(mixedUsage(601), "custom-long", {
      usageAccountingMode: "enforce",
    });
    expect(result.billingUsage?.components[0].prices).toEqual({
      input: "6.00",
      output: "22.50",
      cacheRead: "0.60",
      cacheWrite: "7.50",
      cacheWrite1h: "12.0000000000",
      source: "custom",
    });
  });

  test("prices each billable component at its own prompt size", async () => {
    await makeModel("executor", { ...BASE_PRICES, ...LONG_PRICES });
    await makeModel("advisor", { ...BASE_PRICES, ...LONG_PRICES });
    const usage = normalizeAnthropicUsage(
      {
        input_tokens: 500,
        output_tokens: 10,
        iterations: [
          { type: "message", input_tokens: 500, output_tokens: 10 },
          {
            type: "advisor_message",
            model: "advisor",
            input_tokens: 2000,
            output_tokens: 10,
          },
        ],
      },
      "executor",
    );
    const result = await costs(usage, "executor", {
      usageAccountingMode: "enforce",
    });
    const [executor, advisor] = result.billingUsage?.components ?? [];
    expect([executor.prices.input, advisor.prices.input]).toEqual([
      "3.00",
      "6.00",
    ]);
    // 500*3 + 10*15 + 2000*6 + 10*22.5
    expect(result.actualCost).toBeCloseTo(0.013875, 10);
  });

  test("custom prices still win over provider-instance prices, which win over synced ones", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "fixture-key" } });
    const key = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider: "openai",
    });
    const synced = {
      promptPricePerToken: "0.000009",
      completionPricePerToken: "0.000009",
    };
    const custom = await makeModel(
      "custom-priced",
      {
        ...synced,
        customPricePerMillionInput: "1",
        customPricePerMillionOutput: "2",
      },
      "openai",
    );
    const instance = await makeModel("instance-priced", synced, "openai");
    await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
      key.id,
      [custom, instance].map((model) => ({
        id: model.id,
        modelId: model.modelId,
        providerPricing: {
          promptPricePerToken: "0.000004",
          completionPricePerToken: "0.000005",
          cacheReadPricePerToken: null,
          cacheWritePricePerToken: null,
        },
      })),
      "openai",
    );
    const price = async (model: string) =>
      (
        await calculateInteractionCosts({
          actualModel: model,
          usage: { inputTokens: 1000, outputTokens: 1000 },
          providerName: "openai",
          providerApiKeyId: key.id,
        })
      ).actualCost;
    expect(await price("custom-priced")).toBeCloseTo(0.003, 10);
    expect(await price("instance-priced")).toBeCloseTo(0.009, 10);
  });

  test("records the cost the provider reports instead of the price-table estimate", async () => {
    await makeModel("reported", BASE_PRICES, "openrouter");
    const result = await calculateInteractionCosts({
      actualModel: "reported",
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        providerReportedCost: 0.0123,
      },
      providerName: "openrouter",
    });
    expect(result.actualCost).toBe(0.0123);
  });

  test("records no costs when the provider reported no usage", async () => {
    const result = await costs(
      { inputTokens: 0, outputTokens: 0, usageUnavailable: true },
      "unknown-model",
    );
    expect(result).toEqual({
      actualCost: undefined,
      cacheCost: undefined,
      cacheSavings: undefined,
      cacheReadSavings: undefined,
    });
  });
});

describe("smart-tier baseline", () => {
  const record = (
    usage: UsageView,
    actualModel: string,
    result: Awaited<ReturnType<typeof calculateInteractionCosts>>,
  ) =>
    buildInteractionRecord({
      agent: { id: "agent-1" } as Parameters<
        typeof buildInteractionRecord
      >[0]["agent"],
      billingMode: "metered",
      providerType: "anthropic:messages",
      request: {},
      processedRequest: {},
      response: {},
      actualModel,
      usage,
      costs: result,
    });

  const autoRouting = (modelId: string) => ({
    decisionId: "decision-1",
    smartModel: { modelId, provider: "anthropic" },
  });

  test("prices the smart model with its own quote on the same usage in both modes", async () => {
    await makeModel("cheap", {
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "2",
      customPricePerMillionCacheRead: "0.1",
      customPricePerMillionCacheWrite: "1.25",
    });
    await makeModel("smart", { ...BASE_PRICES, ...LONG_PRICES });
    for (const usageAccountingMode of [undefined, "enforce"] as const) {
      const usage = mixedUsage(601);
      const result = await costs(usage, "cheap", {
        usageAccountingMode,
        autoRouting: autoRouting("smart"),
      });
      const row = record(usage, "cheap", result);
      expect(row.baselineModel).toBe("smart");
      // The smart model's long-context quote: see the threshold test.
      expect(Number(row.baselineCost)).toBeCloseTo(0.006966, 10);
      // 601*1 + 100*2 + 300*0.1 + 60*1.25 + 40*2
      expect(Number(row.cost)).toBeCloseTo(0.000986, 10);
    }
  });

  test("falls back to the actual model when the smart model has no price", async () => {
    await makeModel("cheap", BASE_PRICES);
    for (const usageAccountingMode of [undefined, "enforce"] as const) {
      const usage = mixedUsage(600);
      const result = await costs(usage, "cheap", {
        usageAccountingMode,
        autoRouting: autoRouting("unpriced-smart"),
      });
      const row = record(usage, "cheap", result);
      expect(row.baselineModel).toBe("cheap");
      expect(row.baselineCost).toBe(row.cost);
    }
  });

  test("without routing context the baseline is the model actually used", async () => {
    await makeModel("cheap", BASE_PRICES);
    const usage = mixedUsage(600);
    const row = record(usage, "cheap", await costs(usage, "cheap"));
    expect(row.baselineModel).toBe("cheap");
    expect(row.baselineCost).toBe(row.cost);
  });
});
