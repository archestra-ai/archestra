import { describe, expect, test } from "vitest";
import type { ModelsDevApiResponse } from "@/clients/models-dev-client";
import { buildModelsToUpsert } from "./model-sync";
import {
  OPENAI_PUBLISHED_PRICE_IDS,
  resolveOpenAiPublishedPrices,
} from "./openai-published-pricing";

function resolve(modelId: string) {
  return resolveOpenAiPublishedPrices({ provider: "openai", modelId });
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

function sync(modelId: string, modelsDevData: ModelsDevApiResponse) {
  const [built] = buildModelsToUpsert({
    provider: "openai",
    models: [{ id: modelId, underlyingModelName: null }],
    modelsDevData,
  });
  return built;
}

describe("resolveOpenAiPublishedPrices", () => {
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
      resolveOpenAiPublishedPrices({
        provider: "bedrock",
        modelId: "gpt-5.1-codex",
      }),
    ).toBeNull();
    expect(resolve("gpt-5.1-codex-notarealvariant")).toBeNull();
  });

  test("every mapped id resolves to a price", () => {
    for (const modelId of OPENAI_PUBLISHED_PRICE_IDS) {
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
