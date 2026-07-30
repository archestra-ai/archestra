import type { SupportedProvider } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import type { ModelsDevApiResponse } from "@/clients/models-dev-client";
import { buildModelsToUpsert } from "./model-sync";
import {
  resolveVendorPublishedPrices,
  VENDOR_PUBLISHED_PRICE_IDS,
} from "./vendor-published-pricing";

function resolve(modelId: string) {
  return resolveVendorPublishedPrices({ provider: "openai", modelId });
}

/** A registry that already carries `gpt-5.1-codex`, at a price of its own. */
const REGISTRY_WITH_CODEX: ModelsDevApiResponse = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.1-codex": {
        id: "gpt-5.1-codex",
        name: "GPT-5.1 Codex",
        cost: { input: 9.99, output: 99.9 },
      },
    },
  },
};

function sync(
  modelId: string,
  modelsDevData: ModelsDevApiResponse,
  provider: SupportedProvider = "openai",
) {
  const [built] = buildModelsToUpsert({
    provider,
    models: [{ id: modelId, underlyingModelName: null }],
    modelsDevData,
  });
  return built;
}

/** How the registry lists Gemma: the model is there, the cost is empty. */
const REGISTRY_WITHOUT_A_GEMMA_PRICE: ModelsDevApiResponse = {
  google: {
    id: "google",
    name: "Google",
    models: {
      "gemma-4-26b-a4b-it": {
        id: "gemma-4-26b-a4b-it",
        name: "Gemma 4 26B",
        cost: {},
        limit: { context: 262144, output: 32768 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
};

describe("resolveVendorPublishedPrices", () => {
  test("prices a Codex model the registry does not carry", () => {
    expect(resolve("gpt-5.1-codex")).toEqual({
      promptPricePerToken: "0.00000125",
      completionPricePerToken: "0.00001",
      cacheReadPricePerToken: "1.25e-7",
    });
  });

  test("prices the mini variant apart from its base model", () => {
    // Stripping `-codex-mini` to reach `gpt-5.1` would bill this at five times
    // its published rate, which is why every id is stated rather than derived.
    expect(resolve("gpt-5.1-codex-mini")).toEqual({
      promptPricePerToken: "2.5e-7",
      completionPricePerToken: "0.000002",
      cacheReadPricePerToken: "2.5e-8",
    });
    expect(resolve("gpt-5.1-codex")?.promptPricePerToken).toBe("0.00000125");
  });

  test("resolves a date-pinned release through the undated id", () => {
    expect(resolve("gpt-5.2-codex-2025-11-13")).toEqual(
      resolve("gpt-5.2-codex"),
    );
  });

  test("prices nothing for another provider or an unknown model", () => {
    expect(
      resolveVendorPublishedPrices({
        provider: "bedrock",
        modelId: "gpt-5.1-codex",
      }),
    ).toBeNull();
    expect(resolve("gpt-5.1-codex-notarealvariant")).toBeNull();
  });

  test("every mapped id resolves to a price", () => {
    for (const modelId of VENDOR_PUBLISHED_PRICE_IDS) {
      expect(resolve(modelId), modelId).not.toBeNull();
    }
  });
});

describe("the published map as a gap-filler", () => {
  test("the registry wins when it carries the model", () => {
    // The map ranks last, so a registry entry beats it even when the two
    // disagree. This is what lets the map be deleted once models.dev backfills.
    expect(sync("gpt-5.1-codex", REGISTRY_WITH_CODEX)).toMatchObject({
      promptPricePerToken: "0.00000999",
      completionPricePerToken: "0.0000999",
    });
  });

  test("the map fills in when the registry omits the model", () => {
    expect(
      sync("gpt-5.1-codex", {
        openai: { id: "openai", name: "OpenAI", models: {} },
      }),
    ).toMatchObject({
      promptPricePerToken: "0.00000125",
      completionPricePerToken: "0.00001",
      cacheReadPricePerToken: "1.25e-7",
    });
  });

  test("a model in neither is left unpriced rather than guessed at", () => {
    expect(
      sync("gpt-5.1-codex-notarealvariant", {
        openai: { id: "openai", name: "OpenAI", models: {} },
      }),
    ).toMatchObject({
      promptPricePerToken: null,
      completionPricePerToken: null,
    });
  });
});

describe("a registry entry that carries no price", () => {
  test("prices Gemma from Google's own rate", () => {
    // The entry resolves, so context and modalities come from the registry; only
    // the cost is missing, and an empty cost is a gap rather than a free model.
    expect(
      sync("gemma-4-26b-a4b-it", REGISTRY_WITHOUT_A_GEMMA_PRICE, "gemini"),
    ).toMatchObject({
      // Below 1e-6 the stored string is exponential; $0.15/M is 1.5e-7.
      promptPricePerToken: "1.5e-7",
      completionPricePerToken: "6e-7",
      cacheReadPricePerToken: "1.5e-8",
      contextLength: 262144,
    });
  });

  test("reaches the same price through Vertex's serverless id", () => {
    // Vertex appends `-maas` to the serverless copy of an open model, which the
    // registry does not key.
    expect(
      sync("gemma-4-26b-a4b-it-maas", REGISTRY_WITHOUT_A_GEMMA_PRICE, "gemini"),
    ).toMatchObject({
      promptPricePerToken: "1.5e-7",
      completionPricePerToken: "6e-7",
    });
  });

  test("asserts a cache rate rather than deriving one", () => {
    // Google charges a tenth of the input price; the multiplier Gemini models
    // fall back to is a quarter, which would bill 2.5x the real rate. Pinned as
    // an absolute value: comparing the two fields to each other also holds when
    // both are absent.
    expect(
      sync("gemma-4-26b-a4b-it", REGISTRY_WITHOUT_A_GEMMA_PRICE, "gemini")
        .cacheReadPricePerToken,
    ).toBe("1.5e-8");
  });

  test("prices nothing for a reseller serving the same weights", () => {
    // An open model is served by many providers at their own margins, and a
    // reseller's own registry entry already carries the rate that applies.
    expect(
      resolveVendorPublishedPrices({
        provider: "openrouter",
        modelId: "gemma-4-26b-a4b-it",
      }),
    ).toBeNull();
  });
});

describe("an id the registry keys with its suffix intact", () => {
  test("takes the entry naming it over the one it strips to", () => {
    // Vertex prices some `-maas` ids directly, and those rates differ from what
    // other hosts charge for the same weights. The undecorated form is a
    // fallback, so it must not displace an entry that names the id as stored.
    const registry: ModelsDevApiResponse = {
      google: {
        id: "google",
        name: "Google",
        models: {
          "llama-3.3-70b-instruct-maas": {
            id: "llama-3.3-70b-instruct-maas",
            name: "Llama 3.3 70B (Vertex)",
            cost: { input: 0.72, output: 0.72 },
          },
          "llama-3.3-70b-instruct": {
            id: "llama-3.3-70b-instruct",
            name: "Llama 3.3 70B",
            cost: { input: 0.22, output: 0.5 },
          },
        },
      },
    };

    expect(
      sync("llama-3.3-70b-instruct-maas", registry, "gemini"),
    ).toMatchObject({
      promptPricePerToken: "7.2e-7",
      completionPricePerToken: "7.2e-7",
    });
  });
});
