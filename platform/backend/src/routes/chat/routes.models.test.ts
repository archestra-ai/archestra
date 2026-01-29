import type { GoogleGenAI } from "@google/genai";
import { vi } from "vitest";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  fetchBedrockModels,
  fetchGeminiModels,
  fetchGeminiModelsViaVertexAi,
  mapOpenAiModelToModelInfo,
} from "./routes.models";

// Mock fetch globally for testing API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock cacheManager while preserving other exports (like LRUCacheManager, CacheKey)
const mockCacheStore = new Map<string, unknown>();
vi.mock("@/cache-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cache-manager")>();
  return {
    ...actual,
    cacheManager: {
      get: vi.fn(async (key: string) => mockCacheStore.get(key)),
      set: vi.fn(async (key: string, value: unknown) => {
        mockCacheStore.set(key, value);
        return value;
      }),
      delete: vi.fn(async (key: string) => {
        const existed = mockCacheStore.has(key);
        mockCacheStore.delete(key);
        return existed;
      }),
      wrap: vi.fn(
        async <T>(
          key: string,
          fn: () => Promise<T>,
          _opts?: { ttl?: number },
        ): Promise<T> => {
          const cached = mockCacheStore.get(key);
          if (cached !== undefined) {
            return cached as T;
          }
          const result = await fn();
          mockCacheStore.set(key, result);
          return result;
        },
      ),
    },
  };
});

// Mock the Google GenAI client for Vertex AI tests
vi.mock("@/clients/gemini-client", () => ({
  createGoogleGenAIClient: vi.fn(),
  isVertexAiEnabled: vi.fn(),
}));

import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/clients/gemini-client";

const mockCreateGoogleGenAIClient = vi.mocked(createGoogleGenAIClient);
const mockIsVertexAiEnabled = vi.mocked(isVertexAiEnabled);

describe("chat-models", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    // Clear the mock cache store to ensure clean state for caching tests
    mockCacheStore.clear();
  });

  describe("fetchGeminiModels (API key mode)", () => {
    test("fetches and filters Gemini models that support generateContent", async () => {
      const mockResponse = {
        models: [
          {
            name: "models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            supportedGenerationMethods: [
              "generateContent",
              "countTokens",
              "createCachedContent",
            ],
          },
          {
            name: "models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/embedding-001",
            displayName: "Text Embedding",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchGeminiModels("test-api-key");

      expect(models).toHaveLength(2);
      expect(models).toEqual([
        {
          id: "gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          provider: "gemini",
        },
        {
          id: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          provider: "gemini",
        },
      ]);

      // Verify fetch was called with correct URL
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchUrl = mockFetch.mock.calls[0][0];
      expect(fetchUrl).toContain("/v1beta/models");
      expect(fetchUrl).toContain("key=test-api-key");
      expect(fetchUrl).toContain("pageSize=100");
    });

    test("throws error on API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Invalid API key"),
      });

      await expect(fetchGeminiModels("invalid-key")).rejects.toThrow(
        "Failed to fetch Gemini models: 401",
      );
    });

    test("returns empty array when no models support generateContent", async () => {
      const mockResponse = {
        models: [
          {
            name: "models/embedding-001",
            displayName: "Text Embedding",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchGeminiModels("test-api-key");
      expect(models).toHaveLength(0);
    });

    test("handles models without supportedGenerationMethods field", async () => {
      const mockResponse = {
        models: [
          {
            name: "models/gemini-old",
            displayName: "Old Gemini",
            // No supportedGenerationMethods field
          },
          {
            name: "models/gemini-new",
            displayName: "New Gemini",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchGeminiModels("test-api-key");

      // Only the model with generateContent support should be returned
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("gemini-new");
    });
  });

  describe("fetchGeminiModelsViaVertexAi", () => {
    test("fetches Gemini models using Vertex AI SDK format", async () => {
      // Vertex AI returns models in "publishers/google/models/xxx" format
      // without supportedActions or displayName fields
      const mockModels: Array<{
        name: string;
        version: string;
        tunedModelInfo: Record<string, unknown>;
      }> = [
        {
          name: "publishers/google/models/gemini-2.5-pro",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/gemini-2.5-flash",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/gemini-embedding-001",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/imageclassification-efficientnet",
          version: "001",
          tunedModelInfo: {},
        },
      ];

      // Create async iterator from mock models
      const mockPager = {
        [Symbol.asyncIterator]: async function* () {
          for (const model of mockModels) {
            yield model;
          }
        },
      };

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      // Should include gemini-2.5-pro and gemini-2.5-flash
      // Should exclude gemini-embedding-001 (embedding model)
      // Should exclude imageclassification-efficientnet (non-gemini)
      expect(models).toHaveLength(2);
      expect(models).toEqual([
        {
          id: "gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          provider: "gemini",
        },
        {
          id: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          provider: "gemini",
        },
      ]);

      // Verify SDK was called correctly
      expect(mockCreateGoogleGenAIClient).toHaveBeenCalledWith(
        undefined,
        "[ChatModels]",
      );
      expect(mockClient.models.list).toHaveBeenCalledWith({
        config: { pageSize: 100 },
      });
    });

    test("excludes non-chat models by pattern", async () => {
      const mockModels = [
        {
          name: "publishers/google/models/gemini-2.0-flash-001",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/gemini-embedding-001",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/imagen-3.0",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/text-bison-001",
          version: "default",
          tunedModelInfo: {},
        },
      ];

      const mockPager = {
        [Symbol.asyncIterator]: async function* () {
          for (const model of mockModels) {
            yield model;
          }
        },
      };

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      // Only gemini-2.0-flash-001 should be included
      // embedding, imagen, and text-bison should be excluded
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("gemini-2.0-flash-001");
    });

    test("generates display name from model ID", async () => {
      const mockModels = [
        {
          name: "publishers/google/models/gemini-2.5-flash-lite-preview-09-2025",
          version: "default",
          tunedModelInfo: {},
        },
      ];

      const mockPager = {
        [Symbol.asyncIterator]: async function* () {
          for (const model of mockModels) {
            yield model;
          }
        },
      };

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      expect(models).toHaveLength(1);
      expect(models[0].displayName).toBe(
        "Gemini 2.5 Flash Lite Preview 09 2025",
      );
    });

    test("returns empty array when SDK returns no models", async () => {
      const mockPager = {
        [Symbol.asyncIterator]: async function* () {
          // Empty generator
        },
      };

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();
      expect(models).toHaveLength(0);
    });
  });

  describe("isVertexAiEnabled", () => {
    test("returns true when Vertex AI is enabled in config", () => {
      const originalEnabled = config.llm.gemini.vertexAi.enabled;

      try {
        config.llm.gemini.vertexAi.enabled = true;
        mockIsVertexAiEnabled.mockReturnValue(true);

        expect(mockIsVertexAiEnabled()).toBe(true);
      } finally {
        config.llm.gemini.vertexAi.enabled = originalEnabled;
      }
    });

    test("returns false when Vertex AI is disabled in config", () => {
      const originalEnabled = config.llm.gemini.vertexAi.enabled;

      try {
        config.llm.gemini.vertexAi.enabled = false;
        mockIsVertexAiEnabled.mockReturnValue(false);

        expect(mockIsVertexAiEnabled()).toBe(false);
      } finally {
        config.llm.gemini.vertexAi.enabled = originalEnabled;
      }
    });
  });

  describe("mapOpenAiModelToModelInfo", () => {
    describe("OpenAi.Types.Model", () => {
      test("maps standard OpenAI model", () => {
        const result = mapOpenAiModelToModelInfo({
          id: "gpt-4o",
          created: 1715367049,
          object: "model",
          owned_by: "openai",
        });

        expect(result).toEqual({
          id: "gpt-4o",
          displayName: "gpt-4o",
          provider: "openai",
          createdAt: new Date(1715367049 * 1000).toISOString(),
        });
      });
    });

    describe("OpenAi.Types.OrlandoModel", () => {
      test("maps Claude model with anthropic provider", () => {
        const result = mapOpenAiModelToModelInfo({
          id: "claude-3-5-sonnet",
          name: "claude-3-5-sonnet",
        });

        expect(result).toEqual({
          id: "claude-3-5-sonnet",
          displayName: "claude-3-5-sonnet",
          provider: "anthropic",
          createdAt: undefined,
        });
      });

      test("maps Gemini model with gemini provider", () => {
        const result = mapOpenAiModelToModelInfo({
          id: "gemini-2.5-pro",
          name: "gemini-2.5-pro",
        });

        expect(result).toEqual({
          id: "gemini-2.5-pro",
          displayName: "gemini-2.5-pro",
          provider: "gemini",
          createdAt: undefined,
        });
      });

      test("maps GPT model with openai provider", () => {
        const result = mapOpenAiModelToModelInfo({
          id: "gpt-5",
          name: "gpt-5",
        });

        expect(result).toEqual({
          id: "gpt-5",
          displayName: "gpt-5",
          provider: "openai",
          createdAt: undefined,
        });
      });
    });
  });

  describe("fetchBedrockModels", () => {
    const originalBaseUrl = config.llm.bedrock.baseUrl;
    const originalPrefix = config.llm.bedrock.inferenceProfilePrefix;

    beforeEach(() => {
      config.llm.bedrock.baseUrl =
        "https://bedrock-runtime.us-east-1.amazonaws.com";
      config.llm.bedrock.inferenceProfilePrefix = "";
    });

    afterEach(() => {
      config.llm.bedrock.baseUrl = originalBaseUrl;
      config.llm.bedrock.inferenceProfilePrefix = originalPrefix;
    });

    test("only includes models with TEXT input modality", async () => {
      const mockResponse = {
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-sonnet",
            modelName: "Claude 3 Sonnet",
            providerName: "Anthropic",
            inputModalities: ["TEXT", "IMAGE"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
          {
            modelId: "stability.stable-diffusion-xl",
            modelName: "Stable Diffusion XL",
            providerName: "Stability AI",
            inputModalities: ["TEXT", "IMAGE"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
          {
            modelId: "amazon.titan-image-generator",
            modelName: "Titan Image Generator",
            providerName: "Amazon",
            inputModalities: ["IMAGE"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models).toHaveLength(2);
      expect(models.map((m) => m.id)).toEqual([
        "anthropic.claude-3-sonnet",
        "stability.stable-diffusion-xl",
      ]);
    });

    test("excludes models with no inputModalities", async () => {
      const mockResponse = {
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-sonnet",
            modelName: "Claude 3 Sonnet",
            providerName: "Anthropic",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
          {
            modelId: "unknown-model",
            modelName: "Unknown Model",
            providerName: "Unknown",
            inferenceTypesSupported: ["ON_DEMAND"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("anthropic.claude-3-sonnet");
    });

    test("without inferenceProfilePrefix, keeps only ON_DEMAND models", async () => {
      config.llm.bedrock.inferenceProfilePrefix = "";

      const mockResponse = {
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-sonnet",
            modelName: "Claude 3 Sonnet",
            providerName: "Anthropic",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
          {
            modelId: "anthropic.claude-3-5-sonnet",
            modelName: "Claude 3.5 Sonnet",
            providerName: "Anthropic",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["INFERENCE_PROFILE"],
          },
          {
            modelId: "meta.llama3-70b",
            modelName: "Llama 3 70B",
            providerName: "Meta",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND", "INFERENCE_PROFILE"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      // Only ON_DEMAND supported models should be included
      expect(models).toHaveLength(2);
      expect(models.map((m) => m.id)).toEqual([
        "anthropic.claude-3-sonnet",
        "meta.llama3-70b",
      ]);
    });

    test("with inferenceProfilePrefix, keeps ON_DEMAND and INFERENCE_PROFILE models", async () => {
      config.llm.bedrock.inferenceProfilePrefix = "us";

      const mockResponse = {
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-sonnet",
            modelName: "Claude 3 Sonnet",
            providerName: "Anthropic",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
          {
            modelId: "anthropic.claude-3-5-sonnet",
            modelName: "Claude 3.5 Sonnet",
            providerName: "Anthropic",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["INFERENCE_PROFILE"],
          },
          {
            modelId: "meta.llama3-70b",
            modelName: "Llama 3 70B",
            providerName: "Meta",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["PROVISIONED"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      // ON_DEMAND + INFERENCE_PROFILE, but not PROVISIONED
      expect(models).toHaveLength(2);
      expect(models.map((m) => m.id)).toEqual([
        "anthropic.claude-3-sonnet",
        "us.anthropic.claude-3-5-sonnet",
      ]);
    });

    test("prefixes INFERENCE_PROFILE model IDs with inferenceProfilePrefix", async () => {
      config.llm.bedrock.inferenceProfilePrefix = "eu.";

      const mockResponse = {
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-sonnet",
            modelName: "Claude 3 Sonnet",
            providerName: "Anthropic",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND", "INFERENCE_PROFILE"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models).toHaveLength(1);
      // Model supports INFERENCE_PROFILE and prefix is set, so ID is prefixed
      expect(models[0].id).toBe("eu.anthropic.claude-3-sonnet");
    });

    test("appends dot to inferenceProfilePrefix if missing", async () => {
      config.llm.bedrock.inferenceProfilePrefix = "us";

      const mockResponse = {
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-sonnet",
            modelName: "Claude 3 Sonnet",
            providerName: "Anthropic",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["INFERENCE_PROFILE"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models[0].id).toBe("us.anthropic.claude-3-sonnet");
    });

    test("constructs display name from providerName and modelName", async () => {
      const mockResponse = {
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-sonnet",
            modelName: "Claude 3 Sonnet",
            providerName: "Anthropic",
            inputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models[0].displayName).toBe("Anthropic Claude 3 Sonnet");
      expect(models[0].provider).toBe("bedrock");
    });

    test("calls Bedrock API with correct URL and auth header", async () => {
      const mockResponse = { modelSummaries: [] };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await fetchBedrockModels("my-api-key");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://bedrock.us-east-1.amazonaws.com/foundation-models?byOutputModality=TEXT&byInputModality=TEXT",
      );
      expect(options.headers.Authorization).toBe("Bearer my-api-key");
    });

    test("returns empty array when baseUrl is not configured", async () => {
      config.llm.bedrock.baseUrl = "";

      const models = await fetchBedrockModels("test-api-key");

      expect(models).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("throws error on API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve("Forbidden"),
      });

      await expect(fetchBedrockModels("bad-key")).rejects.toThrow(
        "Failed to fetch Bedrock models: 403",
      );
    });

    test("returns empty array when no modelSummaries in response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const models = await fetchBedrockModels("test-api-key");
      expect(models).toEqual([]);
    });
  });
});
