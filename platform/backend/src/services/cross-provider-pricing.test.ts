import { describe, expect, test } from "vitest";
import type { ModelsDevApiResponse } from "@/clients/models-dev-client";
import { resolveCrossProviderPrices } from "./cross-provider-pricing";

// Minimal models.dev fixture mirroring real shapes: the canonical `anthropic`
// entry carries cache prices; the `amazon-bedrock` entry is keyed by the Bedrock
// model id (sometimes region-prefixed) and covers vendors like Meta/Amazon/
// DeepSeek that don't map to a canonical key. The amazon-bedrock anthropic entry
// deliberately omits cache prices to prove the canonical entry is preferred.
const MODELS_DEV: ModelsDevApiResponse = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      // dated key (matches a dated Bedrock model id after suffix stripping)
      "claude-3-5-sonnet-20241022": {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
      // dateless key (Bedrock id carries a date that must be stripped to match)
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
      },
    },
  },
  "amazon-bedrock": {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    models: {
      // region-prefixed key
      "us.meta.llama3-3-70b-instruct-v1:0": {
        id: "us.meta.llama3-3-70b-instruct-v1:0",
        name: "Llama 3.3 70B",
        cost: { input: 0.72, output: 0.72 },
      },
      // no-prefix key, with a cache_read (as Nova has)
      "amazon.nova-pro-v1:0": {
        id: "amazon.nova-pro-v1:0",
        name: "Nova Pro",
        cost: { input: 0.8, output: 3.2, cache_read: 0.2 },
      },
      "deepseek.r1-v1:0": {
        id: "deepseek.r1-v1:0",
        name: "DeepSeek R1",
        cost: { input: 1.35, output: 5.4 },
      },
      // anthropic on bedrock WITHOUT cache prices (canonical entry must win)
      "anthropic.claude-sonnet-4-5-20250929-v1:0": {
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        name: "Claude Sonnet 4.5 (Bedrock)",
        cost: { input: 3, output: 15 },
      },
    },
  },
};

describe("resolveCrossProviderPrices — Bedrock", () => {
  test("resolves a region-prefixed, dated inference-profile id to the anthropic entry (with cache prices)", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      modelsDevData: MODELS_DEV,
    });

    // models.dev per-million -> per-token strings
    expect(prices).toEqual({
      promptPricePerToken: "0.000003",
      completionPricePerToken: "0.000015",
      cacheReadPricePerToken: "3e-7",
      cacheWritePricePerToken: "0.00000375",
    });
  });

  test("strips a trailing date when the registry key is dateless", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      modelsDevData: MODELS_DEV,
    });

    expect(prices?.cacheReadPricePerToken).toBe("3e-7");
    expect(prices?.cacheWritePricePerToken).toBe("0.00000375");
  });

  test("works without a region prefix", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      modelsDevData: MODELS_DEV,
    });

    expect(prices?.promptPricePerToken).toBe("0.000003");
  });

  test("resolves an application-inference-profile (opaque id) via the foundation-model id from its ARN", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      // Application inference profiles have an opaque id with no vendor encoded.
      modelId:
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
      // ...but the profile's model ARN yields the canonical foundation-model id.
      underlyingModelName: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      modelsDevData: MODELS_DEV,
    });

    expect(prices?.cacheReadPricePerToken).toBe("3e-7");
    expect(prices?.cacheWritePricePerToken).toBe("0.00000375");
  });

  test("prefers the resolved underlying model id over the inference-profile id", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      underlyingModelName: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      modelsDevData: MODELS_DEV,
    });

    // Resolves to the underlying-model entry, not the profile-id one.
    expect(prices?.promptPricePerToken).toBe("0.000003");
  });

  test("resolves a Meta model via the amazon-bedrock entry (region-prefixed key)", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "us.meta.llama3-3-70b-instruct-v1:0",
      modelsDevData: MODELS_DEV,
    });

    expect(prices).toEqual({
      promptPricePerToken: "7.2e-7",
      completionPricePerToken: "7.2e-7",
      cacheReadPricePerToken: null,
      cacheWritePricePerToken: null,
    });
  });

  test("resolves an Amazon Nova model (incl. its cache_read) via amazon-bedrock", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "us.amazon.nova-pro-v1:0",
      modelsDevData: MODELS_DEV,
    });

    expect(prices?.promptPricePerToken).toBe("8e-7");
    expect(prices?.completionPricePerToken).toBe("0.0000032");
    expect(prices?.cacheReadPricePerToken).toBe("2e-7");
    expect(prices?.cacheWritePricePerToken).toBeNull();
  });

  test("resolves a DeepSeek model via amazon-bedrock", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "us.deepseek.r1-v1:0",
      modelsDevData: MODELS_DEV,
    });

    expect(prices?.promptPricePerToken).toBe("0.00000135");
    expect(prices?.completionPricePerToken).toBe("0.0000054");
  });

  test("prefers the canonical anthropic entry (cache prices) over the amazon-bedrock entry", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      modelsDevData: MODELS_DEV,
    });

    // amazon-bedrock also lists this model but without cache prices; the
    // canonical anthropic entry must win so cache prices are recovered.
    expect(prices?.cacheReadPricePerToken).toBe("3e-7");
    expect(prices?.cacheWritePricePerToken).toBe("0.00000375");
  });

  test("returns null for an unknown vendor", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "us.unknownvendor.some-model-v1:0",
      modelsDevData: MODELS_DEV,
    });

    expect(prices).toBeNull();
  });

  test("returns null when the vendor model is absent from the registry", () => {
    const prices = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "us.anthropic.claude-imaginary-9-v1:0",
      modelsDevData: MODELS_DEV,
    });

    expect(prices).toBeNull();
  });
});

describe("resolveCrossProviderPrices — Azure", () => {
  test("uses the underlying model name to resolve the openai entry", () => {
    const prices = resolveCrossProviderPrices({
      provider: "azure",
      modelId: "prod-chat-deployment",
      underlyingModelName: "gpt-4o",
      modelsDevData: MODELS_DEV,
    });

    expect(prices).toEqual({
      promptPricePerToken: "0.0000025",
      completionPricePerToken: "0.00001",
      cacheReadPricePerToken: "0.00000125",
      cacheWritePricePerToken: null,
    });
  });

  test("falls back to the deployment id when no underlying name is known", () => {
    const prices = resolveCrossProviderPrices({
      provider: "azure",
      modelId: "gpt-4o",
      modelsDevData: MODELS_DEV,
    });

    expect(prices?.promptPricePerToken).toBe("0.0000025");
  });

  test("strips a hyphenated date suffix from a versioned model name", () => {
    const prices = resolveCrossProviderPrices({
      provider: "azure",
      modelId: "prod-deployment",
      underlyingModelName: "gpt-4o-2024-08-06",
      modelsDevData: MODELS_DEV,
    });

    expect(prices?.promptPricePerToken).toBe("0.0000025");
  });

  test("returns null when the deployment name matches no known model", () => {
    const prices = resolveCrossProviderPrices({
      provider: "azure",
      modelId: "my-arbitrary-deployment",
      modelsDevData: MODELS_DEV,
    });

    expect(prices).toBeNull();
  });
});

test("returns null for providers that match models.dev keys directly", () => {
  const prices = resolveCrossProviderPrices({
    provider: "anthropic",
    modelId: "claude-3-5-sonnet-20241022",
    modelsDevData: MODELS_DEV,
  });

  expect(prices).toBeNull();
});
