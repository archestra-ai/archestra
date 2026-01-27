import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelMetadataModel, TokenPriceModel } from "@/models";
import type {
  ModelsDevApiResponse,
  ModelsDevModel,
  ModelsDevProvider,
} from "./models-dev-client";

// Use vi.hoisted to create mock functions that can be used in vi.mock factory
const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

// Mock global fetch
vi.stubGlobal("fetch", mockFetch);

// Import after mock is defined
import { modelsDevClient } from "./models-dev-client";

// Mock the cache manager to avoid "CacheManager: Not started" errors
vi.mock("@/cache-manager", () => {
  class MockLRUCacheManager {
    get() {
      return undefined;
    }
    set() {}
    delete() {
      return true;
    }
    has() {
      return false;
    }
    clear() {}
  }

  return {
    CacheKey: { GetChatModels: "get-chat-models" },
    cacheManager: {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    },
    LRUCacheManager: MockLRUCacheManager,
  };
});

/**
 * Helper to create a mock models.dev model object
 */
function createMockModel(
  overrides: Partial<ModelsDevModel> = {},
): ModelsDevModel {
  return {
    id: "test-model",
    name: "Test Model",
    family: "test",
    attachment: false,
    reasoning: false,
    tool_call: false,
    structured_output: false,
    temperature: true,
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    cost: {
      input: 0,
      output: 0,
    },
    limit: {
      context: 8192,
      output: 4096,
    },
    ...overrides,
  };
}

/**
 * Helper to create a mock models.dev provider object
 */
function createMockProvider(
  id: string,
  models: Record<string, ModelsDevModel>,
): ModelsDevProvider {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    npm: `@ai-sdk/${id}`,
    env: [`${id.toUpperCase()}_API_KEY`],
    doc: `https://docs.${id}.com`,
    models,
  };
}

/**
 * Helper to create a mock API response
 */
function createMockApiResponse(
  providers: Record<string, ModelsDevProvider>,
): ModelsDevApiResponse {
  return providers;
}

describe("ModelsDevClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(async () => {
    await ModelMetadataModel.deleteAll();
    await TokenPriceModel.deleteAll();
  });

  describe("fetchModelsFromApi", () => {
    test("returns providers on successful API call", async () => {
      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({ id: "gpt-4o", name: "GPT-4o" }),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await modelsDevClient.fetchModelsFromApi();

      expect(Object.keys(result)).toHaveLength(1);
      expect(result.openai.models["gpt-4o"].name).toBe("GPT-4o");
    });

    test("returns empty object on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const result = await modelsDevClient.fetchModelsFromApi();

      expect(result).toEqual({});
    });

    test("returns empty object on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network Error"));

      const result = await modelsDevClient.fetchModelsFromApi();

      expect(result).toEqual({});
    });
  });

  describe("mapProvider", () => {
    test("maps supported providers correctly", () => {
      expect(modelsDevClient.mapProvider("openai")).toBe("openai");
      expect(modelsDevClient.mapProvider("anthropic")).toBe("anthropic");
      expect(modelsDevClient.mapProvider("google")).toBe("gemini");
      expect(modelsDevClient.mapProvider("cohere")).toBe("cohere");
      expect(modelsDevClient.mapProvider("cerebras")).toBe("cerebras");
      expect(modelsDevClient.mapProvider("mistral")).toBe("mistral");
    });

    test("maps OpenAI-compatible providers to openai", () => {
      expect(modelsDevClient.mapProvider("llama")).toBe("openai");
      expect(modelsDevClient.mapProvider("deepseek")).toBe("openai");
      expect(modelsDevClient.mapProvider("groq")).toBe("openai");
      expect(modelsDevClient.mapProvider("fireworks-ai")).toBe("openai");
      expect(modelsDevClient.mapProvider("togetherai")).toBe("openai");
    });

    test("returns null for explicitly unsupported providers", () => {
      expect(modelsDevClient.mapProvider("perplexity")).toBeNull();
      expect(modelsDevClient.mapProvider("xai")).toBeNull();
      expect(modelsDevClient.mapProvider("nvidia")).toBeNull();
      expect(modelsDevClient.mapProvider("amazon-bedrock")).toBeNull();
      expect(modelsDevClient.mapProvider("azure")).toBeNull();
    });

    test("returns null for unknown providers", () => {
      expect(modelsDevClient.mapProvider("unknown-provider")).toBeNull();
    });
  });

  describe("convertToModelMetadata", () => {
    test("converts model with all fields", () => {
      const model = createMockModel({
        id: "gpt-4o",
        name: "GPT-4o",
        tool_call: true,
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        cost: {
          input: 5,
          output: 15,
        },
        limit: {
          context: 128000,
          output: 16384,
        },
      });

      const result = modelsDevClient.convertToModelMetadata("openai", model);

      expect(result).not.toBeNull();
      expect(result?.externalId).toBe("openai/gpt-4o");
      expect(result?.provider).toBe("openai");
      expect(result?.modelId).toBe("gpt-4o");
      expect(result?.description).toBe("GPT-4o");
      expect(result?.contextLength).toBe(128000);
      expect(result?.inputModalities).toEqual(["text", "image", "pdf"]);
      expect(result?.outputModalities).toEqual(["text"]);
      expect(result?.supportsToolCalling).toBe(true);
      expect(Number(result?.promptPricePerToken)).toBeCloseTo(0.000005);
      expect(Number(result?.completionPricePerToken)).toBeCloseTo(0.000015);
    });

    test("returns null for unsupported provider", () => {
      const model = createMockModel({ id: "test-model", name: "Test" });
      const result = modelsDevClient.convertToModelMetadata(
        "perplexity",
        model,
      );
      expect(result).toBeNull();
    });

    test("defaults to text modality when modalities are empty", () => {
      const model = createMockModel({
        id: "test-model",
        modalities: { input: [], output: [] },
      });

      const result = modelsDevClient.convertToModelMetadata("openai", model);

      expect(result?.inputModalities).toEqual(["text"]);
      expect(result?.outputModalities).toEqual(["text"]);
    });

    test("filters out invalid modalities", () => {
      const model = createMockModel({
        id: "test-model",
        modalities: {
          input: ["text", "invalid-modality", "image"],
          output: ["text", "unknown"],
        },
      });

      const result = modelsDevClient.convertToModelMetadata("openai", model);

      expect(result?.inputModalities).toEqual(["text", "image"]);
      expect(result?.outputModalities).toEqual(["text"]);
    });

    test("handles missing cost data", () => {
      const model = createMockModel({
        id: "test-model",
        cost: undefined,
      });

      const result = modelsDevClient.convertToModelMetadata("openai", model);

      expect(result?.promptPricePerToken).toBeNull();
      expect(result?.completionPricePerToken).toBeNull();
    });

    test("handles missing context length", () => {
      const model = createMockModel({
        id: "test-model",
        limit: undefined,
      });

      const result = modelsDevClient.convertToModelMetadata("openai", model);

      expect(result?.contextLength).toBeNull();
    });
  });

  describe("syncModelMetadata", () => {
    test("syncs models and returns count", async () => {
      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({
            id: "gpt-4o",
            name: "GPT-4o",
            cost: { input: 5, output: 15 },
          }),
        }),
        anthropic: createMockProvider("anthropic", {
          "claude-3-5-sonnet": createMockModel({
            id: "claude-3-5-sonnet",
            name: "Claude 3.5 Sonnet",
            cost: { input: 3, output: 15 },
          }),
        }),
        perplexity: createMockProvider("perplexity", {
          "sonar-medium": createMockModel({
            id: "sonar-medium",
            name: "Sonar Medium",
          }),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const count = await modelsDevClient.syncModelMetadata(true);

      // Should sync 2 models (openai + anthropic), not perplexity
      expect(count).toBe(2);

      const openaiMetadata = await ModelMetadataModel.findByProviderAndModelId(
        "openai",
        "gpt-4o",
      );
      expect(openaiMetadata).not.toBeNull();
      expect(openaiMetadata?.description).toBe("GPT-4o");

      const anthropicMetadata =
        await ModelMetadataModel.findByProviderAndModelId(
          "anthropic",
          "claude-3-5-sonnet",
        );
      expect(anthropicMetadata).not.toBeNull();
    });

    test("maps Google provider to Gemini", async () => {
      const mockResponse = createMockApiResponse({
        google: createMockProvider("google", {
          "gemini-pro": createMockModel({
            id: "gemini-pro",
            name: "Gemini Pro",
          }),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await modelsDevClient.syncModelMetadata(true);

      const metadata = await ModelMetadataModel.findByProviderAndModelId(
        "gemini",
        "gemini-pro",
      );
      expect(metadata).not.toBeNull();
      expect(metadata?.provider).toBe("gemini");
    });

    test("returns 0 when API returns no providers", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const count = await modelsDevClient.syncModelMetadata(true);
      expect(count).toBe(0);
    });

    test("handles models with PDF input modality", async () => {
      const mockResponse = createMockApiResponse({
        anthropic: createMockProvider("anthropic", {
          "claude-3-opus": createMockModel({
            id: "claude-3-opus",
            name: "Claude 3 Opus",
            modalities: {
              input: ["text", "image", "pdf"],
              output: ["text"],
            },
          }),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await modelsDevClient.syncModelMetadata(true);

      const metadata = await ModelMetadataModel.findByProviderAndModelId(
        "anthropic",
        "claude-3-opus",
      );
      expect(metadata?.inputModalities).toEqual(["text", "image", "pdf"]);
    });

    test("detects tool calling support", async () => {
      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({
            id: "gpt-4o",
            name: "GPT-4o",
            tool_call: true,
          }),
          "gpt-3.5-turbo-instruct": createMockModel({
            id: "gpt-3.5-turbo-instruct",
            name: "GPT-3.5 Turbo Instruct",
            tool_call: false,
          }),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await modelsDevClient.syncModelMetadata(true);

      const gpt4Metadata = await ModelMetadataModel.findByProviderAndModelId(
        "openai",
        "gpt-4o",
      );
      expect(gpt4Metadata?.supportsToolCalling).toBe(true);

      const instructMetadata =
        await ModelMetadataModel.findByProviderAndModelId(
          "openai",
          "gpt-3.5-turbo-instruct",
        );
      expect(instructMetadata?.supportsToolCalling).toBe(false);
    });
  });

  describe("syncTokenPrices", () => {
    test("creates token prices for models with pricing data", async () => {
      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({
            id: "gpt-4o",
            name: "GPT-4o",
            cost: { input: 5, output: 15 },
          }),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await modelsDevClient.syncModelMetadata(true);

      const tokenPrice = await TokenPriceModel.findByProviderAndModelId(
        "openai",
        "gpt-4o",
      );
      expect(tokenPrice).not.toBeNull();
      expect(tokenPrice?.pricePerMillionInput).toBe("5.00");
      expect(tokenPrice?.pricePerMillionOutput).toBe("15.00");
    });

    test("does not overwrite existing token prices", async () => {
      // Create an existing token price entry
      await TokenPriceModel.create({
        model: "gpt-4o",
        provider: "openai",
        pricePerMillionInput: "10.00",
        pricePerMillionOutput: "20.00",
      });

      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({
            id: "gpt-4o",
            name: "GPT-4o",
            cost: { input: 5, output: 15 },
          }),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await modelsDevClient.syncModelMetadata(true);

      const tokenPrice = await TokenPriceModel.findByProviderAndModelId(
        "openai",
        "gpt-4o",
      );
      // Should keep the original prices
      expect(tokenPrice?.pricePerMillionInput).toBe("10.00");
      expect(tokenPrice?.pricePerMillionOutput).toBe("20.00");
    });

    test("creates token prices for multiple models", async () => {
      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({
            id: "gpt-4o",
            name: "GPT-4o",
            cost: { input: 5, output: 15 },
          }),
        }),
        anthropic: createMockProvider("anthropic", {
          "claude-3-opus": createMockModel({
            id: "claude-3-opus",
            name: "Claude 3 Opus",
            cost: { input: 15, output: 75 },
          }),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await modelsDevClient.syncModelMetadata(true);

      const gpt4Price = await TokenPriceModel.findByProviderAndModelId(
        "openai",
        "gpt-4o",
      );
      expect(gpt4Price?.pricePerMillionInput).toBe("5.00");
      expect(gpt4Price?.pricePerMillionOutput).toBe("15.00");

      const claudePrice = await TokenPriceModel.findByProviderAndModelId(
        "anthropic",
        "claude-3-opus",
      );
      expect(claudePrice?.pricePerMillionInput).toBe("15.00");
      expect(claudePrice?.pricePerMillionOutput).toBe("75.00");
    });
  });
});
