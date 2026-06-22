import { describe, expect, test } from "vitest";
import type { ModelsDevApiResponse } from "@/clients/models-dev-client";
import { resolveCrossProviderPrices } from "./cross-provider-pricing";

// Minimal models.dev fixture: anthropic carries cache prices, openai does not,
// and the (region-keyed) amazon-bedrock entry omits cache prices entirely.
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
