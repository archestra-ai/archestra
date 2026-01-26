import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openRouterModelRegistry } from "./openrouter-model-registry";
import { ModelMetadataModel } from "@/models";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the cache manager to avoid "CacheManager: Not started" errors
vi.mock("@/cache-manager", () => {
  // Mock LRUCacheManager as a class
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

describe("OpenRouterModelRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up test data
    await ModelMetadataModel.deleteAll();
  });

  describe("fetchModelsFromApi", () => {
    test("returns models on successful API call", async () => {
      const mockResponse = {
        data: [
          {
            id: "openai/gpt-4o",
            name: "GPT-4o",
            description: "OpenAI's GPT-4o model",
            context_length: 128000,
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
            },
            pricing: {
              prompt: "0.000005",
              completion: "0.000015",
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await openRouterModelRegistry.fetchModelsFromApi();

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("openai/gpt-4o");
      expect(models[0].name).toBe("GPT-4o");
    });

    test("returns empty array on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const models = await openRouterModelRegistry.fetchModelsFromApi();

      expect(models).toEqual([]);
    });

    test("returns empty array on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const models = await openRouterModelRegistry.fetchModelsFromApi();

      expect(models).toEqual([]);
    });
  });

  describe("syncModelMetadata", () => {
    test("syncs models and returns count", async () => {
      const mockResponse = {
        data: [
          {
            id: "openai/gpt-4o",
            name: "GPT-4o",
            description: "OpenAI's GPT-4o model",
            context_length: 128000,
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
            },
            pricing: {
              prompt: "0.000005",
              completion: "0.000015",
            },
          },
          {
            id: "anthropic/claude-3-5-sonnet",
            name: "Claude 3.5 Sonnet",
            description: "Anthropic's Claude 3.5 Sonnet",
            context_length: 200000,
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
            },
            pricing: {
              prompt: "0.000003",
              completion: "0.000015",
            },
          },
          {
            id: "unsupported/model",
            name: "Unsupported Model",
            description: "This provider is not supported",
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const count = await openRouterModelRegistry.syncModelMetadata(true);

      // Should sync 2 models (openai and anthropic), skip unsupported
      expect(count).toBe(2);

      // Verify models were saved
      const openaiMetadata = await ModelMetadataModel.findByProviderAndModelId(
        "openai",
        "gpt-4o",
      );
      expect(openaiMetadata).not.toBeNull();
      expect(openaiMetadata?.description).toBe("OpenAI's GPT-4o model");
      expect(openaiMetadata?.contextLength).toBe(128000);

      const anthropicMetadata =
        await ModelMetadataModel.findByProviderAndModelId(
          "anthropic",
          "claude-3-5-sonnet",
        );
      expect(anthropicMetadata).not.toBeNull();
    });

    test("maps Google provider to Gemini", async () => {
      const mockResponse = {
        data: [
          {
            id: "google/gemini-pro",
            name: "Gemini Pro",
            description: "Google's Gemini Pro",
            context_length: 32000,
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await openRouterModelRegistry.syncModelMetadata(true);

      const metadata = await ModelMetadataModel.findByProviderAndModelId(
        "gemini",
        "gemini-pro",
      );
      expect(metadata).not.toBeNull();
      expect(metadata?.provider).toBe("gemini");
    });

    test("returns 0 when API returns no models", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const count = await openRouterModelRegistry.syncModelMetadata(true);
      expect(count).toBe(0);
    });

    test("handles models without pricing gracefully", async () => {
      const mockResponse = {
        data: [
          {
            id: "openai/gpt-4",
            name: "GPT-4",
            description: "GPT-4",
            context_length: 8192,
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
            },
            // No pricing provided
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await openRouterModelRegistry.syncModelMetadata(true);

      const metadata = await ModelMetadataModel.findByProviderAndModelId(
        "openai",
        "gpt-4",
      );
      expect(metadata).not.toBeNull();
      expect(metadata?.promptPricePerToken).toBeNull();
      expect(metadata?.completionPricePerToken).toBeNull();
    });

    test("defaults to text modality when not specified", async () => {
      const mockResponse = {
        data: [
          {
            id: "openai/gpt-3.5-turbo",
            name: "GPT-3.5 Turbo",
            description: "GPT-3.5 Turbo",
            context_length: 16385,
            // No architecture/modalities specified
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await openRouterModelRegistry.syncModelMetadata(true);

      const metadata = await ModelMetadataModel.findByProviderAndModelId(
        "openai",
        "gpt-3.5-turbo",
      );
      expect(metadata).not.toBeNull();
      expect(metadata?.inputModalities).toEqual(["text"]);
      expect(metadata?.outputModalities).toEqual(["text"]);
    });
  });
});
