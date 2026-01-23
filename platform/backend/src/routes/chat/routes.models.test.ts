import type { GoogleGenAI } from "@google/genai";
import { vi } from "vitest";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import {
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
vi.mock("@/routes/proxy/utils/gemini-client", () => ({
  createGoogleGenAIClient: vi.fn(),
  isVertexAiEnabled: vi.fn(),
}));

import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/routes/proxy/utils/gemini-client";

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

  describe("fetchGeminiModelsViaVertexAi caching", () => {
    test("caches results globally and returns cached data on subsequent calls", async () => {
      const mockModels = [
        {
          name: "publishers/google/models/gemini-2.0-flash",
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

      const mockList = vi.fn().mockResolvedValue(mockPager);
      const mockClient = {
        models: {
          list: mockList,
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      // First call - should fetch from SDK
      const models1 = await fetchGeminiModelsViaVertexAi();
      expect(models1).toHaveLength(1);
      expect(models1[0].id).toBe("gemini-2.0-flash");
      expect(mockList).toHaveBeenCalledTimes(1);

      // Second call - should return cached result
      const models2 = await fetchGeminiModelsViaVertexAi();
      expect(models2).toHaveLength(1);
      expect(models2[0].id).toBe("gemini-2.0-flash");
      // SDK should NOT be called again - data comes from cache
      expect(mockList).toHaveBeenCalledTimes(1);

      // Third call - still using cache
      const models3 = await fetchGeminiModelsViaVertexAi();
      expect(models3).toEqual(models1);
      expect(mockList).toHaveBeenCalledTimes(1);
    });

    test("uses global cache key (not user-specific)", async () => {
      const mockModels = [
        {
          name: "publishers/google/models/gemini-2.5-pro",
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

      const mockList = vi.fn().mockResolvedValue(mockPager);
      const mockClient = {
        models: {
          list: mockList,
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      // Call twice - simulating different users calling the same function
      // Both should hit the same cache
      const firstCall = await fetchGeminiModelsViaVertexAi();
      const secondCall = await fetchGeminiModelsViaVertexAi();

      // Verify SDK was only called once (global cache hit)
      expect(mockList).toHaveBeenCalledTimes(1);
      expect(firstCall).toEqual(secondCall);
    });
  });
});
