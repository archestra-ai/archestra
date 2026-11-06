import { randomUUID } from "node:crypto";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { describe, expect, test } from "@/test";
import type { CreateModel, UsageView } from "@/types";
import type { AutoRoutingRequestContext } from "@/types/auto-routing";
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

  test("configured long prices over a default base are not an estimate", async () => {
    await makeModel("long-only", LONG_PRICES);
    const result = await costs(mixedUsage(601), "long-only");
    expect(result.billingUsage?.components[0].prices.source).toBe("custom");
    expect(result.billingUsage?.issues).toEqual([]);
    expect(result.actualCost).toBeCloseTo(0.006966, 10);
  });

  test("long prices replace the custom rates while the source stays custom", async () => {
    await makeModel("custom-long", {
      ...BASE_PRICES,
      ...LONG_PRICES,
      promptPricePerToken: "0.000001",
      completionPricePerToken: "0.000002",
    });
    const result = await costs(mixedUsage(601), "custom-long");
    expect(result.billingUsage?.components[0].prices).toEqual({
      input: "6.00000000",
      output: "22.50000000",
      cacheRead: "0.60000000",
      cacheWrite: "7.50000000",
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
    const result = await costs(usage, "executor");
    const [executor, advisor] = result.billingUsage?.components ?? [];
    expect([executor.prices.input, advisor.prices.input]).toEqual([
      "3.00000000",
      "6.00000000",
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
    const usage: UsageView = {
      inputTokens: 1200,
      outputTokens: 300,
      providerReportedCost: 0.0123,
    };
    const result = await calculateInteractionCosts({
      actualModel: "reported",
      usage,
      providerName: "openrouter",
    });
    expect(result).toMatchObject({
      actualCost: 0.0123,
      cacheCost: undefined,
      cacheSavings: undefined,
      cacheReadSavings: undefined,
    });
    // The provider's charge is authoritative: settled as reported, not estimated.
    expect(result.billingUsage).toMatchObject({
      status: "complete",
      issues: [],
      cost: "0.0123000000",
      components: [{ prices: { source: "provider" } }],
    });
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

  const autoRouting = (
    modelId: string,
    params: {
      provider?: AutoRoutingRequestContext["smartModel"]["provider"];
      providerApiKeyId?: string;
    } = {},
  ): AutoRoutingRequestContext => ({
    decisionId: "decision-1",
    smartModel: {
      modelId,
      provider: params.provider ?? "anthropic",
      providerApiKeyId: params.providerApiKeyId ?? randomUUID(),
    },
    derivedSessionKey: null,
  });

  test("prices the smart baseline at the provider instance the smart tier is served by", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "fixture-key" } });
    const key = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider: "openai",
    });
    const smart = await makeModel(
      "instance-smart",
      { promptPricePerToken: "0.000009", completionPricePerToken: "0.000009" },
      "openai",
    );
    await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
      key.id,
      [
        {
          id: smart.id,
          modelId: smart.modelId,
          providerPricing: {
            promptPricePerToken: "0.000004",
            completionPricePerToken: "0.000004",
            cacheReadPricePerToken: null,
            cacheWritePricePerToken: null,
          },
        },
      ],
      "openai",
    );
    const usage: UsageView = { inputTokens: 1000, outputTokens: 0 };
    const result = await calculateInteractionCosts({
      actualModel: "instance-smart",
      usage,
      providerName: "openai",
      providerApiKeyId: key.id,
      autoRouting: autoRouting("instance-smart", {
        provider: "openai",
        providerApiKeyId: key.id,
      }),
    });
    expect(result.actualCost).toBeCloseTo(0.004, 10);
    expect(Number(result.baseline?.cost)).toBeCloseTo(0.004, 10);
  });

  test("a smart model priced only by its long-context group is a known baseline above the threshold", async () => {
    await makeModel("cheap", BASE_PRICES);
    await makeModel("long-only-smart", LONG_PRICES);
    const usage = mixedUsage(601);
    const result = await costs(usage, "cheap", {
      autoRouting: autoRouting("long-only-smart"),
    });
    const row = record(usage, "cheap", result);
    expect(row.baselineModel).toBe("long-only-smart");
    // 601*6 + 100*22.5 + 300*0.6 + 60*7.5 + 40*12
    expect(Number(row.baselineCost)).toBeCloseTo(0.006966, 10);
  });

  test("prices the smart model with its own quote on the same usage", async () => {
    await makeModel("cheap", {
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "2",
      customPricePerMillionCacheRead: "0.1",
      customPricePerMillionCacheWrite: "1.25",
    });
    await makeModel("smart", { ...BASE_PRICES, ...LONG_PRICES });
    const usage = mixedUsage(601);
    const result = await costs(usage, "cheap", {
      autoRouting: autoRouting("smart"),
    });
    const row = record(usage, "cheap", result);
    expect(row.baselineModel).toBe("smart");
    // The smart model's long-context quote: see the threshold test.
    expect(Number(row.baselineCost)).toBeCloseTo(0.006966, 10);
    // 601*1 + 100*2 + 300*0.1 + 60*1.25 + 40*2
    expect(Number(row.cost)).toBeCloseTo(0.000986, 10);
  });

  test("reprices executor components reported under a dated model id and keeps advisor prices", async () => {
    const cheap = {
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "2",
    };
    await makeModel("cheap", cheap);
    await makeModel("cheap-20260101", cheap);
    await makeModel("advisor", { ...BASE_PRICES, ...LONG_PRICES });
    await makeModel("smart", {
      customPricePerMillionInput: "15",
      customPricePerMillionOutput: "75",
    });
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
      "cheap-20260101",
    );

    const result = await costs(usage, "cheap", {
      autoRouting: autoRouting("smart"),
    });

    // Executor on smart: 500*15 + 10*75; advisor at its long-context price: 2000*6 + 10*22.5.
    expect(Number(result.baseline?.cost)).toBeCloseTo(0.020475, 10);
    // Executor on cheap: 500*1 + 10*2; advisor unchanged.
    expect(result.actualCost).toBeCloseTo(0.012745, 10);
  });

  test("falls back to the actual model when the smart model has no price", async () => {
    await makeModel("cheap", BASE_PRICES);
    const usage = mixedUsage(600);
    const result = await costs(usage, "cheap", {
      autoRouting: autoRouting("unpriced-smart"),
    });
    const row = record(usage, "cheap", result);
    expect(row.baselineModel).toBe("cheap");
    expect(row.baselineCost).toBe(row.cost);
  });

  test("without routing context the baseline is the model actually used", async () => {
    await makeModel("cheap", BASE_PRICES);
    const usage = mixedUsage(600);
    const row = record(usage, "cheap", await costs(usage, "cheap"));
    expect(row.baselineModel).toBe("cheap");
    expect(row.baselineCost).toBe(row.cost);
  });
});
