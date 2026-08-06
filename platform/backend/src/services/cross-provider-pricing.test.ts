import { describe, expect, test } from "vitest";
import type { ModelsDevApiResponse } from "@/clients/models-dev-client";
import {
  resolveCrossProviderPrices,
  resolveDiscoveredModelRegistryEntry,
  resolveSelfHostedModelMetadata,
} from "./cross-provider-pricing";

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
  meta: {
    id: "meta",
    name: "Meta",
    models: {
      "llama-4-maverick": {
        id: "llama-4-maverick",
        name: "Llama 4 Maverick",
        cost: { input: 0.22, output: 0.85 },
        limit: { context: 1048576, output: 16384 },
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
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
      // Two generations of one Amazon model, distinguished only by the `-vN`
      // segment, priced five times apart. Amazon ids carry that segment as part
      // of the model's identity rather than as a Bedrock version, so collapsing
      // it would merge these two entries onto one key.
      "amazon.titan-embed-text-v1": {
        id: "amazon.titan-embed-text-v1",
        name: "Titan Embeddings G1 Text",
        cost: { input: 0.1, output: 0 },
      },
      "amazon.titan-embed-text-v2:0": {
        id: "amazon.titan-embed-text-v2:0",
        name: "Titan Text Embeddings V2",
        cost: { input: 0.02, output: 0 },
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

  // The version-stripping that canonicalises `…-v1:0` to `…` is correct for
  // every vendor mapped to a canonical registry entry, where `-vN` is a Bedrock
  // version. Amazon is not one of those vendors, and its `-vN` is part of the
  // model name — so these two ids must keep resolving to their own entries.
  test("keeps two Amazon generations that differ only by `-vN` distinct", () => {
    const v1 = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "amazon.titan-embed-text-v1",
      modelsDevData: MODELS_DEV,
    });
    const v2 = resolveCrossProviderPrices({
      provider: "bedrock",
      modelId: "amazon.titan-embed-text-v2:0",
      modelsDevData: MODELS_DEV,
    });

    expect(v1?.promptPricePerToken).toBe("1e-7");
    expect(v2?.promptPricePerToken).toBe("2e-8");
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

describe("resolveDiscoveredModelRegistryEntry", () => {
  // A client can send any model name to any gateway endpoint, and the row is
  // recorded under the endpoint's provider. Provider-scoped resolution then
  // matches nothing, even when the registry lists the model under its own
  // vendor, so the model lands on the fabricated default estimate.
  test("prices a vendor model that arrived at a mismatched provider endpoint", () => {
    const resolved = resolveDiscoveredModelRegistryEntry({
      provider: "bedrock",
      modelId: "gpt-4o",
      modelsDevData: MODELS_DEV,
    });

    expect(resolved?.prices).toEqual({
      promptPricePerToken: "0.0000025",
      completionPricePerToken: "0.00001",
      cacheReadPricePerToken: "0.00000125",
      cacheWritePricePerToken: null,
    });
  });

  test("still prefers the provider-scoped match when one exists", () => {
    const resolved = resolveDiscoveredModelRegistryEntry({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      modelsDevData: MODELS_DEV,
    });

    // The bedrock entry, not a registry-wide guess.
    expect(resolved?.prices?.promptPricePerToken).toBe("0.000003");
    expect(resolved?.metadata?.contextLength).toBeNull();
  });

  test("abstains when no first-party vendor lists the model", () => {
    expect(
      resolveDiscoveredModelRegistryEntry({
        provider: "bedrock",
        modelId: "somevendor.private-model-v3",
        modelsDevData: MODELS_DEV,
      }),
    ).toBeNull();
  });

  test("does not resolve a model listed only by a reseller", () => {
    // `us.meta.llama3-3-70b-instruct-v1:0` exists in the fixture under
    // amazon-bedrock only. Reached as a bare id under another provider it must
    // not be priced from that reseller row.
    expect(
      resolveDiscoveredModelRegistryEntry({
        provider: "openai",
        modelId: "us.meta.llama3-3-70b-instruct-v1:0",
        modelsDevData: MODELS_DEV,
      }),
    ).toBeNull();
  });
});

describe("resolveSelfHostedModelMetadata", () => {
  test("matches a HuggingFace path to the vendor that publishes the model", () => {
    expect(
      resolveSelfHostedModelMetadata({
        modelId: "meta-llama/Llama-4-Maverick",
        modelsDevData: MODELS_DEV,
      }),
    ).toMatchObject({
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsToolCalling: true,
    });
  });

  test("asserts no window or output limit, whatever the vendor publishes", () => {
    // The entry carries a 1M window; the server that serves it decides its own.
    const metadata = resolveSelfHostedModelMetadata({
      modelId: "meta-llama/Llama-4-Maverick",
      modelsDevData: MODELS_DEV,
    });

    expect(metadata?.contextLength).toBeNull();
    expect(metadata?.outputLength).toBeNull();
  });

  test("reports nothing for a name no vendor publishes", () => {
    expect(
      resolveSelfHostedModelMetadata({
        modelId: "our-finetune-v3",
        modelsDevData: MODELS_DEV,
      }),
    ).toBeNull();
  });

  test("ignores a reseller listing, matching only the vendor", () => {
    // `us.meta.llama3-3-70b-instruct-v1:0` exists under amazon-bedrock alone.
    expect(
      resolveSelfHostedModelMetadata({
        modelId: "us.meta.llama3-3-70b-instruct-v1:0",
        modelsDevData: MODELS_DEV,
      }),
    ).toBeNull();
  });

  test("reports nothing when vendors disagree about what the name means", () => {
    // An operator alias can collide with an unrelated model. Two vendors
    // publishing the same bare name with different modalities means the name
    // does not identify one model, so nothing is asserted.
    const ambiguous: ModelsDevApiResponse = {
      ...MODELS_DEV,
      cohere: {
        id: "cohere",
        name: "Cohere",
        models: {
          "llama-4-maverick": {
            id: "llama-4-maverick",
            name: "Not the same model",
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    };

    expect(
      resolveSelfHostedModelMetadata({
        modelId: "meta-llama/Llama-4-Maverick",
        modelsDevData: ambiguous,
      }),
    ).toBeNull();
  });
});
