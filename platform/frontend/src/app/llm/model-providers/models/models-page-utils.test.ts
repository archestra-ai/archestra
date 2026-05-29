import { describe, expect, it } from "vitest";
import {
  canFilterFreeModelsForApiKey,
  filterModelsForPage,
  type ModelsPageAvailableApiKey,
  type ModelsPageFilterableModel,
  OBSERVED_MODEL_SOURCE_DESCRIPTION,
  OBSERVED_MODEL_SOURCE_LABEL,
} from "./models-page-utils";

const availableApiKeys = [
  ["openrouter-key", { provider: "openrouter" }],
  ["openai-key", { provider: "openai" }],
] as const satisfies readonly ModelsPageAvailableApiKey[];

const models = [
  {
    modelId: "openrouter/free",
    provider: "openrouter",
    apiKeys: [{ id: "openrouter-key" }],
    embeddingDimensions: null,
    isFree: true,
  },
  {
    modelId: "openrouter/paid",
    provider: "openrouter",
    apiKeys: [{ id: "openrouter-key" }],
    embeddingDimensions: null,
    isFree: false,
  },
  {
    modelId: "gpt-4o",
    provider: "openai",
    apiKeys: [{ id: "openai-key" }],
    embeddingDimensions: null,
    isFree: false,
  },
] as const satisfies readonly ModelsPageFilterableModel[];

describe("canFilterFreeModelsForApiKey", () => {
  it("allows the free-model filter only for all models with OpenRouter or a selected OpenRouter key", () => {
    expect(
      canFilterFreeModelsForApiKey({
        availableApiKeys,
        apiKeyFilter: "all",
      }),
    ).toBe(true);
    expect(
      canFilterFreeModelsForApiKey({
        availableApiKeys,
        apiKeyFilter: "openrouter-key",
      }),
    ).toBe(true);
    expect(
      canFilterFreeModelsForApiKey({
        availableApiKeys,
        apiKeyFilter: "openai-key",
      }),
    ).toBe(false);
    expect(
      canFilterFreeModelsForApiKey({
        availableApiKeys,
        apiKeyFilter: "unknown-key",
      }),
    ).toBe(false);
  });
});

describe("filterModelsForPage", () => {
  it("does not apply a stale free-model filter to a selected non-OpenRouter API key", () => {
    const canFilterFreeModels = canFilterFreeModelsForApiKey({
      availableApiKeys,
      apiKeyFilter: "openai-key",
    });

    const result = filterModelsForPage({
      models,
      search: "",
      apiKeyFilter: "openai-key",
      modelTypeFilter: "all",
      freeOnly: true,
      canFilterFreeModels,
    });

    expect(result.map((model) => model.modelId)).toEqual(["gpt-4o"]);
  });

  it("applies the free-model filter to a selected OpenRouter API key", () => {
    const canFilterFreeModels = canFilterFreeModelsForApiKey({
      availableApiKeys,
      apiKeyFilter: "openrouter-key",
    });

    const result = filterModelsForPage({
      models,
      search: "",
      apiKeyFilter: "openrouter-key",
      modelTypeFilter: "all",
      freeOnly: true,
      canFilterFreeModels,
    });

    expect(result.map((model) => model.modelId)).toEqual(["openrouter/free"]);
  });
});

describe("observed model source copy", () => {
  it("uses end-user wording without exposing the implementation source name", () => {
    expect(OBSERVED_MODEL_SOURCE_LABEL).toBe("Observed in requests");
    expect(OBSERVED_MODEL_SOURCE_DESCRIPTION).toBe(
      "This model was first seen in traffic through a model gateway. It may not appear in a provider catalog.",
    );
  });
});
