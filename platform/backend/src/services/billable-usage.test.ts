import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { modelsDevClient } from "@/clients/models-dev-client";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { test as fixtureTest } from "@/test";
import { useMswServer } from "@/test/msw";
import { normalizeAnthropicUsage, sumMoney } from "@/utils/billable-usage";
import { priceBillingUsage } from "./billable-usage";
import { isFireworksEndpoint } from "./fireworks-model";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest HTTP boundary fixture
const server = useMswServer();

test("uses provider-specific rates for model-name collisions and estimates missing cache rates at half the input rate", async () => {
  for (const provider of ["openrouter", "anthropic"] as const)
    await ModelModel.create({
      provider,
      modelId: "shared-model",
      externalId: `${provider}/shared-model`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: provider === "openrouter" ? "1" : "100",
      customPricePerMillionOutput: "5",
    });
  const priced = await priceBillingUsage({
    model: "shared-model",
    provider: "openrouter",
    mode: "enforce",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 2000 },
  });
  // 100 * 1 + 20 * 5 + 2000 cache reads at half the input rate of 1, per million
  expect(priced.cost).toBe("0.0012000000");
  expect(priced.status).toBe("incomplete");
  expect(priced.issues).toEqual(["estimated_cache_price"]);
  const authoritative = await priceBillingUsage({
    model: "unknown",
    provider: "openrouter",
    mode: "enforce",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 2000,
      providerReportedCost: 0.123456789,
    },
  });
  expect(authoritative.status).toBe("complete");
  expect(authoritative.cost).toBe("0.1234567890");
  expect(authoritative.components[0].prices.source).toBe("provider");
});

test.each([
  false,
  true,
])("a reported total is preserved when a multi-model allocation cannot be authoritative (zero weights=%s)", async (zeroWeights) => {
  if (zeroWeights)
    for (const model of ["executor", "advisor"])
      await ModelModel.create({
        provider: "anthropic",
        modelId: model,
        externalId: `anthropic/${model}`,
        inputModalities: ["text"],
        outputModalities: ["text"],
        customPricePerMillionInput: "0",
        customPricePerMillionOutput: "0",
      });
  const usage = normalizeAnthropicUsage(
    {
      input_tokens: 100,
      output_tokens: 20,
      iterations: [
        { type: "message", input_tokens: 100, output_tokens: 20 },
        {
          type: "advisor_message",
          model: "advisor",
          input_tokens: 100000,
          output_tokens: 100000,
        },
      ],
    },
    "executor",
  );
  usage.providerReportedCost = 0.00001;
  const priced = await priceBillingUsage({
    model: "executor",
    provider: "anthropic",
    mode: "enforce",
    usage,
  });
  expect(priced.cost).toBe("0.0000100000");
  expect(sumMoney(priced.components.map((component) => component.cost))).toBe(
    priced.cost,
  );
  expect(priced.status).toBe("incomplete");
  expect(priced.issues).toContain("unallocated_provider_cost");
  if (zeroWeights) {
    expect(priced.components[0].cost).toBe("0.0000000000");
    expect(priced.components[1].cost).toBe(priced.cost);
  }
});

test("reuses the request quote across metrics and settlement when model prices change", async () => {
  const model = await ModelModel.create({
    provider: "anthropic",
    modelId: "quoted",
    externalId: "anthropic/quoted",
    inputModalities: ["text"],
    outputModalities: ["text"],
    customPricePerMillionInput: "1",
    customPricePerMillionOutput: "5",
  });
  const usage = { inputTokens: 100, outputTokens: 20 };
  const first = await priceBillingUsage({
    model: "quoted",
    provider: "anthropic",
    usage,
    mode: "enforce",
  });
  await ModelModel.update(model.id, { customPricePerMillionInput: "100" });
  const repeated = await priceBillingUsage({
    model: "quoted",
    provider: "anthropic",
    usage,
    mode: "enforce",
  });
  expect(repeated.cost).toBe(first.cost);
  const nextRequest = await priceBillingUsage({
    model: "quoted",
    provider: "anthropic",
    usage: { inputTokens: 100, outputTokens: 20 },
    mode: "enforce",
  });
  expect(nextRequest.cost).not.toBe(first.cost);
});

fixtureTest(
  "missing paid endpoint prices cannot inherit the self-hosted zero rate",
  async ({ makeOrganization, makeLlmProviderApiKey }) => {
    modelsDevClient.clearFetchCache();
    server.use(
      http.get("https://models.dev/api.json", () => HttpResponse.json({})),
    );
    const org = await makeOrganization();
    const key = await makeLlmProviderApiKey(org.id, null, {
      provider: "vllm",
      baseUrl: "https://api.fireworks.ai/inference/v1",
    });
    const usage = {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 400,
    };
    const priced = await priceBillingUsage({
      model: "accounts/fireworks/models/synthetic-unpriced",
      provider: "vllm",
      providerApiKeyId: key.id,
      usage,
      mode: "enforce",
    });
    expect(Number(priced.cost)).toBeGreaterThan(0);
    expect(priced.status).toBe("incomplete");
    expect(priced.issues).toContain("estimated_model_price");
    const selfHosted = await priceBillingUsage({
      model: "accounts/fireworks/models/synthetic-unpriced",
      provider: "vllm",
      usage: { ...usage, billingQuote: undefined },
      mode: "enforce",
    });
    expect(Number(selfHosted.cost)).toBe(0);
    expect(selfHosted.status).toBe("complete");
  },
);

fixtureTest.for([
  { provider: "vllm" as const, price: "registry" },
  { provider: "openai" as const, price: "registry" },
  { provider: "vllm" as const, price: "custom" },
  { provider: "vllm" as const, price: "zero" },
  { provider: "vllm" as const, price: "instance-zero" },
  { provider: "vllm" as const, price: "instance-partial" },
  { provider: "vllm" as const, price: "missing-cache" },
])(
  "Fireworks endpoint price precedence: $provider/$price",
  async ({ provider, price }, { makeOrganization, makeLlmProviderApiKey }) => {
    const canonical = "accounts/fireworks/models/synthetic-priced";
    modelsDevClient.clearFetchCache();
    server.use(
      http.get("https://models.dev/api.json", () =>
        HttpResponse.json({
          "fireworks-ai": {
            id: "fireworks-ai",
            name: "Fireworks",
            models: {
              [canonical]: {
                id: canonical,
                name: "Synthetic priced model",
                cost: {
                  input: 2,
                  output: 8,
                  ...(price === "missing-cache" ? {} : { cache_read: 0.5 }),
                },
              },
            },
          },
          openai: {
            id: "openai",
            name: "Different seller",
            models: {
              [canonical]: {
                id: canonical,
                name: "Same name elsewhere",
                cost: { input: 100, output: 100, cache_read: 100 },
              },
            },
          },
        }),
      ),
    );
    const org = await makeOrganization();
    const key = await makeLlmProviderApiKey(org.id, null, {
      provider,
      baseUrl: "https://api.fireworks.ai/inference/v1",
    });
    const model = await ModelModel.create({
      externalId: `${provider}/${canonical}`,
      provider,
      modelId: canonical,
      inputModalities: ["text"],
      outputModalities: ["text"],
      // A shared row's seller prices cannot speak for the selected endpoint.
      promptPricePerToken: "0.0001",
      completionPricePerToken: "0.0001",
      ...(price === "custom"
        ? {
            customPricePerMillionInput: "1",
            customPricePerMillionOutput: "5",
            customPricePerMillionCacheRead: "0.25",
          }
        : {}),
      ...(price === "zero"
        ? {
            customPricePerMillionInput: "0",
            customPricePerMillionOutput: "0",
            customPricePerMillionCacheRead: "0",
          }
        : {}),
    });
    if (price.startsWith("instance"))
      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        key.id,
        [
          {
            id: model.id,
            modelId: canonical,
            providerPricing: {
              promptPricePerToken: price === "instance-zero" ? "0" : null,
              completionPricePerToken: "0",
              cacheReadPricePerToken: price === "instance-zero" ? "0" : null,
              cacheWritePricePerToken: null,
            },
          },
        ],
        provider,
      );
    const result = await priceBillingUsage({
      model: canonical,
      provider,
      providerApiKeyId: key.id,
      mode: "enforce",
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400 },
    });
    const expected =
      price === "custom"
        ? 0.0016
        : price === "zero" || price === "instance-zero"
          ? 0
          : price === "instance-partial"
            ? 0.0024
            : price === "missing-cache"
              ? 0.0032
              : 0.003;
    expect(Number(result.cost)).toBeCloseTo(expected, 10);
    expect(result.status).toBe(
      price === "instance-partial" || price === "missing-cache"
        ? "incomplete"
        : "complete",
    );
    if (price === "missing-cache")
      expect(result.issues).toEqual(["estimated_cache_price"]);
    modelsDevClient.clearFetchCache();
  },
);

test.each([
  { customRead: null, customWrite: null, expected: 0.0023 },
  { customRead: "0", customWrite: null, expected: 0.0021 },
  { customRead: null, customWrite: "0", expected: 0.0017 },
])("custom base prices use Fireworks cache rates with independent overrides ($customRead/$customWrite)", async ({
  customRead,
  customWrite,
  expected,
}) => {
  const canonical = "accounts/fireworks/models/synthetic-custom-cache";
  modelsDevClient.clearFetchCache();
  server.use(
    http.get("https://models.dev/api.json", () =>
      HttpResponse.json({
        "fireworks-ai": {
          id: "fireworks-ai",
          name: "Fireworks",
          models: {
            [canonical]: {
              id: canonical,
              name: "Synthetic custom cache model",
              cost: { input: 2, output: 8, cache_read: 0.5, cache_write: 3 },
            },
          },
        },
      }),
    ),
  );
  await ModelModel.create({
    externalId: `vllm/${canonical}`,
    provider: "vllm",
    modelId: canonical,
    inputModalities: ["text"],
    outputModalities: ["text"],
    customPricePerMillionInput: "1",
    customPricePerMillionOutput: "5",
    customPricePerMillionCacheRead: customRead,
    customPricePerMillionCacheWrite: customWrite,
    // These shared seller prices must not leak into the endpoint quote.
    cacheReadPricePerToken: "0.0001",
    cacheWritePricePerToken: "0.0001",
  });
  const result = await priceBillingUsage({
    model: canonical,
    provider: "vllm",
    billingEndpoint: "fireworks",
    mode: "enforce",
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 400,
      cacheWriteTokens: 200,
    },
  });
  expect(Number(result.cost)).toBeCloseTo(expected, 10);
  expect(Number(result.components[0].prices.cacheRead)).toBe(
    customRead === "0" ? 0 : 0.5,
  );
  expect(Number(result.components[0].prices.cacheWrite)).toBe(
    customWrite === "0" ? 0 : 3,
  );
  expect(result.status).toBe("complete");
});

fixtureTest.for(["zero", "partial", "custom"] as const)(
  "uses requested alias instance prices ahead of canonical instance prices: %s",
  async (price, { makeOrganization, makeLlmProviderApiKey }) => {
    const canonical = "accounts/fireworks/models/synthetic-instance-alias";
    const alias = "synthetic-instance-alias";
    modelsDevClient.clearFetchCache();
    server.use(
      http.get("https://models.dev/api.json", () =>
        HttpResponse.json({
          "fireworks-ai": {
            id: "fireworks-ai",
            name: "Fireworks",
            models: {
              [canonical]: {
                id: canonical,
                name: "Synthetic alias model",
                cost: { input: 2, output: 8, cache_read: 0.5 },
              },
            },
          },
        }),
      ),
    );
    const org = await makeOrganization();
    const key = await makeLlmProviderApiKey(org.id, null, {
      provider: "vllm",
      baseUrl: "https://api.fireworks.ai/inference/v1",
    });
    const models = [];
    for (const modelId of [canonical, alias]) {
      const model = await ModelModel.create({
        externalId: `vllm/${modelId}`,
        provider: "vllm",
        modelId,
        inputModalities: ["text"],
        outputModalities: ["text"],
        ...(price === "custom" && modelId === alias
          ? {
              customPricePerMillionInput: "1",
              customPricePerMillionOutput: "5",
              customPricePerMillionCacheRead: "0.25",
            }
          : {}),
      });
      const rate = modelId === canonical ? "0.000009" : "0";
      models.push({
        id: model.id,
        modelId,
        providerPricing: {
          promptPricePerToken:
            modelId === alias && price === "partial" ? null : rate,
          completionPricePerToken: rate,
          cacheReadPricePerToken:
            modelId === alias && price === "partial" ? null : rate,
          cacheWritePricePerToken: null,
        },
      });
    }
    await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
      key.id,
      models,
      "vllm",
    );
    const result = await priceBillingUsage({
      model: canonical,
      requestedModel: alias,
      provider: "vllm",
      providerApiKeyId: key.id,
      mode: "enforce",
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400 },
    });
    expect(Number(result.cost)).toBeCloseTo(
      price === "custom" ? 0.0016 : price === "partial" ? 0.0024 : 0,
      10,
    );
    expect(result.status).toBe(price === "partial" ? "incomplete" : "complete");
    expect(result.components[0].modelAliases).toEqual([alias]);
  },
);

fixtureTest.for([
  { canonicalExists: false, longContext: false },
  { canonicalExists: true, longContext: false },
  { canonicalExists: false, longContext: true },
  { canonicalExists: true, longContext: true },
])(
  "preserves alias custom prices (canonical=$canonicalExists, longContext=$longContext)",
  async ({ canonicalExists, longContext }) => {
    const canonical = "accounts/fireworks/models/synthetic-alias";
    modelsDevClient.clearFetchCache();
    server.use(
      http.get("https://models.dev/api.json", () => HttpResponse.json({})),
    );
    if (canonicalExists)
      await ModelModel.create({
        externalId: `vllm/${canonical}`,
        provider: "vllm",
        modelId: canonical,
        inputModalities: ["text"],
        outputModalities: ["text"],
        customPricePerMillionInput: "9",
        customPricePerMillionOutput: "9",
      });
    await ModelModel.create({
      externalId: "vllm/synthetic-alias",
      provider: "vllm",
      modelId: "synthetic-alias",
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "5",
      customPricePerMillionCacheRead: "0.25",
      ...(longContext
        ? {
            longContextThreshold: 100,
            longContextPricePerMillionInput: "2",
            longContextPricePerMillionOutput: "8",
            longContextPricePerMillionCacheRead: "0.5",
            longContextPricePerMillionCacheWrite: "2",
          }
        : {}),
    });
    const result = await priceBillingUsage({
      model: canonical,
      requestedModel: "synthetic-alias",
      provider: "vllm",
      billingEndpoint: "fireworks",
      mode: "enforce",
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400 },
    });
    expect(Number(result.cost)).toBeCloseTo(longContext ? 0.003 : 0.0016, 10);
    expect(result.status).toBe("complete");
  },
);

test.each([
  "https://api.fireworks.ai/inference",
  "https://api.fireworks.ai/inference/v1",
  "https://api.fireworks.ai:443/inference/v1/",
])("recognizes the documented inference endpoint %s", (url) => {
  expect(isFireworksEndpoint(url)).toBe(true);
});

test.each([
  undefined,
  "http://localhost:8000/v1",
  "https://api.fireworks.ai.example.test/inference/v1",
  "https://api.fireworks.ai@localhost/inference/v1",
  "https://user@api.fireworks.ai/inference/v1",
  "http://api.fireworks.ai/inference/v1",
  "https://api.fireworks.ai:8443/inference/v1",
  "https://api.fireworks.ai/custom/v1",
  "https://api.fireworks.ai/inference/v1?endpoint=other",
  "not a URL",
])("does not infer a paid endpoint from %s", (url) => {
  expect(isFireworksEndpoint(url)).toBe(false);
});

fixtureTest.for([
  "custom",
  "custom-cache",
  "instance-zero",
  "long-context",
] as const)(
  "complete Fireworks $0 prices do not depend on registry availability",
  async (source, { makeOrganization, makeLlmProviderApiKey }) => {
    const canonical = "accounts/fireworks/models/synthetic-local-prices";
    modelsDevClient.clearFetchCache();
    let registryRequests = 0;
    server.use(
      http.get("https://models.dev/api.json", () => {
        registryRequests++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const org = await makeOrganization();
    const key = await makeLlmProviderApiKey(org.id, null, {
      provider: "vllm",
      baseUrl: "https://api.fireworks.ai/inference/v1",
    });
    const model = await ModelModel.create({
      externalId: `vllm/${canonical}`,
      provider: "vllm",
      modelId: canonical,
      inputModalities: ["text"],
      outputModalities: ["text"],
      ...(source !== "instance-zero"
        ? { customPricePerMillionInput: "1", customPricePerMillionOutput: "5" }
        : {}),
      ...(source === "custom-cache"
        ? {
            customPricePerMillionCacheRead: "0.25",
            customPricePerMillionCacheWrite: "0",
          }
        : {}),
      ...(source === "long-context"
        ? {
            longContextThreshold: 100,
            longContextPricePerMillionInput: "2",
            longContextPricePerMillionOutput: "8",
            longContextPricePerMillionCacheRead: "0.5",
            longContextPricePerMillionCacheWrite: "0",
          }
        : {}),
    });
    if (source === "instance-zero")
      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        key.id,
        [
          {
            id: model.id,
            modelId: canonical,
            providerPricing: {
              promptPricePerToken: "0",
              completionPricePerToken: "0",
              cacheReadPricePerToken: "0",
              cacheWritePricePerToken: "0",
            },
          },
        ],
        "vllm",
      );
    try {
      for (let request = 0; request < 2; request++) {
        const result = await priceBillingUsage({
          model: canonical,
          provider: "vllm",
          providerApiKeyId: key.id,
          mode: "enforce",
          usage: {
            inputTokens: 1000,
            outputTokens: 100,
            ...(source !== "custom"
              ? { cacheReadTokens: 400, cacheWriteTokens: 200 }
              : {}),
          },
        });
        expect(result.status).toBe("complete");
        expect(Number(result.cost)).toBeCloseTo(
          source === "instance-zero"
            ? 0
            : source === "long-context"
              ? 0.003
              : source === "custom-cache"
                ? 0.0016
                : 0.0015,
          10,
        );
      }
      expect(registryRequests).toBe(0);
    } finally {
      modelsDevClient.clearFetchCache();
    }
  },
);
