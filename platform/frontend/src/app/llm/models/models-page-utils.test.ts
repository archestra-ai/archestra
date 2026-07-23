import { describe, expect, it } from "vitest";
import {
  canFilterFreeModelsForApiKey,
  filterModelsForPage,
  isKnowledgeBaseEmbeddingModel,
  type ModelsPageAvailableApiKey,
  type ModelsPageFilterableModel,
} from "./models-page-utils";

const availableApiKeys = [
  { id: "openrouter-key", provider: "openrouter" },
  { id: "openai-key", provider: "openai" },
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

describe("isKnowledgeBaseEmbeddingModel", () => {
  const embeddingApiKeys = [
    { id: "gemini-key", provider: "gemini" },
    { id: "openrouter-key", provider: "openrouter" },
  ] as const satisfies readonly ModelsPageAvailableApiKey[];

  it("locks the model the org's embedding config resolves to", () => {
    expect(
      isKnowledgeBaseEmbeddingModel({
        model: { modelId: "gemini-embedding-001", provider: "gemini" },
        embeddingModel: "gemini-embedding-001",
        embeddingChatApiKeyId: "gemini-key",
        availableApiKeys: embeddingApiKeys,
      }),
    ).toBe(true);
  });

  it("does not lock a same-ID model under a different provider", () => {
    expect(
      isKnowledgeBaseEmbeddingModel({
        model: { modelId: "gemini-embedding-001", provider: "openrouter" },
        embeddingModel: "gemini-embedding-001",
        embeddingChatApiKeyId: "gemini-key",
        availableApiKeys: embeddingApiKeys,
      }),
    ).toBe(false);
  });

  it("does not lock anything when no embedding config is set", () => {
    expect(
      isKnowledgeBaseEmbeddingModel({
        model: { modelId: "gemini-embedding-001", provider: "gemini" },
        embeddingModel: null,
        embeddingChatApiKeyId: null,
        availableApiKeys: embeddingApiKeys,
      }),
    ).toBe(false);
  });
});
