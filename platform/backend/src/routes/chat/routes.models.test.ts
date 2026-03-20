import type { GoogleGenAI } from "@google/genai";
import { vi } from "vitest";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  fetchBedrockModels,
  fetchGeminiModels,
  fetchGeminiModelsViaVertexAi,
  fetchModelsForProvider,
  mapOpenAiModelToModelInfo,
  testProviderApiKey,
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
          get: vi.fn(),
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
      expect(mockClient.models.get).not.toHaveBeenCalled();
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
          get: vi.fn(),
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
          get: vi.fn(),
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

      const mockGet = vi.fn().mockRejectedValue(new Error("Not found"));
      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
          get: mockGet,
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();
      expect(models).toHaveLength(0);
      expect(mockGet).toHaveBeenCalled();
    });

    test("falls back to probing known Gemini model IDs when list is incomplete", async () => {
      const mockModels = [
        {
          name: "publishers/google/models/text-embedding-005",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/imagen-4.0-generate-001",
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

      const mockGet = vi.fn(async ({ model }: { model: string }) => {
        if (model === "gemini-2.5-flash") {
          return {
            name: "publishers/google/models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
          };
        }

        if (model === "gemini-2.5-pro") {
          return {
            name: "publishers/google/models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
          };
        }

        throw new Error("Not found");
      });

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
          get: mockGet,
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

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
      expect(mockGet).toHaveBeenCalledWith({ model: "gemini-2.5-pro" });
      expect(mockGet).toHaveBeenCalledWith({ model: "gemini-2.5-flash" });
    });

    test("merges fallback models when list misses primary Gemini chat models", async () => {
      const mockModels = [
        {
          name: "publishers/google/models/gemini-live-2.5-preview",
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

      const mockGet = vi.fn(async ({ model }: { model: string }) => {
        if (model === "gemini-2.5-flash") {
          return {
            name: "publishers/google/models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
          };
        }
        throw new Error("Not found");
      });

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
          get: mockGet,
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      expect(models).toEqual([
        {
          id: "gemini-live-2.5-preview",
          displayName: "Gemini Live 2.5 Preview",
          provider: "gemini",
        },
        {
          id: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          provider: "gemini",
        },
      ]);
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

  describe("fetchModelsForProvider", () => {
    test("returns models when provider has a valid API key", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      await makeChatApiKey(org.id, secret.id, { provider: "deepseek" });

      mockIsVertexAiEnabled.mockReturnValue(false);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "deepseek-chat",
                created: 1700000000,
                owned_by: "deepseek",
              },
            ],
          }),
      });

      const models = await fetchModelsForProvider({
        provider: "deepseek",
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
      });

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("deepseek-chat");
      expect(models[0].provider).toBe("deepseek");
    });

    test("returns empty array when provider has no API key", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockIsVertexAiEnabled.mockReturnValue(false);

      const models = await fetchModelsForProvider({
        provider: "openai",
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
      });

      expect(models).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("vLLM returns models without API key when enabled", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockIsVertexAiEnabled.mockReturnValue(false);
      const originalEnabled = config.llm.vllm.enabled;

      try {
        config.llm.vllm.enabled = true;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: "my-model", object: "model" }],
            }),
        });

        const models = await fetchModelsForProvider({
          provider: "vllm",
          organizationId: org.id,
          userId: user.id,
          userTeamIds: [],
        });

        expect(models).toHaveLength(1);
        expect(models[0].id).toBe("my-model");
        // Should pass "EMPTY" as API key placeholder
        const [, fetchOptions] = mockFetch.mock.calls[0];
        expect(fetchOptions.headers.Authorization).toBe("Bearer EMPTY");
      } finally {
        config.llm.vllm.enabled = originalEnabled;
      }
    });

    test("vLLM returns empty array when disabled and no API key", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockIsVertexAiEnabled.mockReturnValue(false);
      const originalEnabled = config.llm.vllm.enabled;

      try {
        config.llm.vllm.enabled = false;

        const models = await fetchModelsForProvider({
          provider: "vllm",
          organizationId: org.id,
          userId: user.id,
          userTeamIds: [],
        });

        expect(models).toEqual([]);
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        config.llm.vllm.enabled = originalEnabled;
      }
    });

    test("Gemini uses Vertex AI when enabled, even without API key", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      mockIsVertexAiEnabled.mockReturnValue(true);

      const mockPager = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            name: "publishers/google/models/gemini-2.5-pro",
            version: "default",
            tunedModelInfo: {},
          };
        },
      };

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchModelsForProvider({
        provider: "gemini",
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
      });

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("gemini-2.5-pro");
      // Should NOT have called fetch (uses SDK instead)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("Gemini uses API key mode when Vertex AI is disabled", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret = await makeSecret({ secret: { apiKey: "gemini-key" } });
      await makeChatApiKey(org.id, secret.id, { provider: "gemini" });

      mockIsVertexAiEnabled.mockReturnValue(false);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [
              {
                name: "models/gemini-2.5-flash",
                displayName: "Gemini 2.5 Flash",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
      });

      const models = await fetchModelsForProvider({
        provider: "gemini",
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
      });

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("gemini-2.5-flash");
    });

    test("returns empty array and logs error when fetch fails", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      await makeChatApiKey(org.id, secret.id, { provider: "groq" });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const models = await fetchModelsForProvider({
        provider: "groq",
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
      });

      // Should catch the error and return empty array
      expect(models).toEqual([]);
    });

    test("Bedrock returns models when enabled with API key", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const secret = await makeSecret({ secret: { apiKey: "bedrock-key" } });
      await makeChatApiKey(org.id, secret.id, { provider: "bedrock" });

      mockIsVertexAiEnabled.mockReturnValue(false);
      const originalEnabled = config.llm.bedrock.enabled;
      const originalBaseUrl = config.llm.bedrock.baseUrl;

      try {
        config.llm.bedrock.enabled = true;
        config.llm.bedrock.baseUrl =
          "https://bedrock-runtime.us-east-1.amazonaws.com";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              inferenceProfileSummaries: [
                {
                  inferenceProfileId:
                    "us.anthropic.claude-3-sonnet-20240229-v1:0",
                  inferenceProfileName: "Claude 3 Sonnet",
                  status: "ACTIVE",
                  type: "SYSTEM_DEFINED",
                },
              ],
            }),
        });

        const models = await fetchModelsForProvider({
          provider: "bedrock",
          organizationId: org.id,
          userId: user.id,
          userTeamIds: [],
        });

        expect(models).toHaveLength(1);
        expect(models[0].provider).toBe("bedrock");
      } finally {
        config.llm.bedrock.enabled = originalEnabled;
        config.llm.bedrock.baseUrl = originalBaseUrl;
      }
    });
  });

  describe("fetchBedrockModels", () => {
    const originalBaseUrl = config.llm.bedrock.baseUrl;

    beforeEach(() => {
      config.llm.bedrock.baseUrl =
        "https://bedrock-runtime.us-east-1.amazonaws.com";
    });

    afterEach(() => {
      config.llm.bedrock.baseUrl = originalBaseUrl;
    });

    test("returns only ACTIVE inference profiles", async () => {
      const mockResponse = {
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
            inferenceProfileName: "Claude 3.5 Sonnet v2",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
          },
          {
            inferenceProfileId: "us.anthropic.claude-3-haiku-20240307-v1:0",
            inferenceProfileName: "Claude 3 Haiku",
            status: "INACTIVE",
            type: "SYSTEM_DEFINED",
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("us.anthropic.claude-3-5-sonnet-20241022-v2:0");
      expect(models[0].displayName).toBe("Claude 3.5 Sonnet v2");
      expect(models[0].provider).toBe("bedrock");
    });

    test("uses inferenceProfileId as model ID", async () => {
      const mockResponse = {
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-opus-4-20250514-v1:0",
            inferenceProfileName: "Claude Opus 4",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("us.anthropic.claude-opus-4-20250514-v1:0");
    });

    test("calls ListInferenceProfiles API with correct URL and auth header", async () => {
      const mockResponse = { inferenceProfileSummaries: [] };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await fetchBedrockModels("my-api-key");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=1000",
      );
      expect(options.headers.Authorization).toBe("Bearer my-api-key");
    });

    test("handles pagination with nextToken", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: "us.anthropic.claude-3-sonnet",
                  inferenceProfileName: "Claude 3 Sonnet",
                  status: "ACTIVE",
                },
              ],
              nextToken: "page2token",
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: "us.anthropic.claude-3-haiku",
                  inferenceProfileName: "Claude 3 Haiku",
                  status: "ACTIVE",
                },
              ],
            }),
        });

      const models = await fetchBedrockModels("test-api-key");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(models).toHaveLength(2);
      expect(models.map((m) => m.id)).toEqual([
        "us.anthropic.claude-3-sonnet",
        "us.anthropic.claude-3-haiku",
      ]);

      // Verify second call includes nextToken
      const secondCallUrl = mockFetch.mock.calls[1][0] as string;
      expect(secondCallUrl).toContain("nextToken=page2token");
    });

    test("filters out profiles without inferenceProfileId", async () => {
      const mockResponse = {
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-3-sonnet",
            inferenceProfileName: "Claude 3 Sonnet",
            status: "ACTIVE",
          },
          {
            inferenceProfileName: "Missing ID Profile",
            status: "ACTIVE",
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("us.anthropic.claude-3-sonnet");
    });

    test("uses inferenceProfileId as fallback displayName", async () => {
      const mockResponse = {
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-3-sonnet",
            status: "ACTIVE",
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models[0].displayName).toBe("us.anthropic.claude-3-sonnet");
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
        "Failed to fetch Bedrock inference profiles: 403",
      );
    });

    test("returns empty array when no inferenceProfileSummaries in response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const models = await fetchBedrockModels("test-api-key");
      expect(models).toEqual([]);
    });

    describe("allowedProviders filtering", () => {
      const originalAllowedProviders = config.llm.bedrock.allowedProviders;

      afterEach(() => {
        config.llm.bedrock.allowedProviders = originalAllowedProviders;
      });

      test("filters by allowed providers", async () => {
        config.llm.bedrock.allowedProviders = ["anthropic", "amazon"];

        const mockResponse = {
          inferenceProfileSummaries: [
            {
              inferenceProfileId:
                "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.amazon.nova-pro-v1:0",
              inferenceProfileName: "Amazon Nova Pro",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.stability.stable-diffusion-xl-v1",
              inferenceProfileName: "Stable Diffusion XL",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.meta.llama3-70b-instruct-v1:0",
              inferenceProfileName: "Llama 3 70B",
              status: "ACTIVE",
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
          "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
          "us.amazon.nova-pro-v1:0",
        ]);
      });

      test("empty allowedProviders returns all active profiles", async () => {
        config.llm.bedrock.allowedProviders = [];

        const mockResponse = {
          inferenceProfileSummaries: [
            {
              inferenceProfileId:
                "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.stability.stable-diffusion-xl-v1",
              inferenceProfileName: "Stable Diffusion XL",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.meta.llama3-70b-instruct-v1:0",
              inferenceProfileName: "Llama 3 70B",
              status: "ACTIVE",
            },
          ],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        });

        const models = await fetchBedrockModels("test-api-key");

        expect(models).toHaveLength(3);
      });

      test("handles global prefix profiles", async () => {
        config.llm.bedrock.allowedProviders = ["anthropic"];

        const mockResponse = {
          inferenceProfileSummaries: [
            {
              inferenceProfileId:
                "global.anthropic.claude-sonnet-4-6-20250514-v1:0",
              inferenceProfileName: "Claude Sonnet 4.6",
              status: "ACTIVE",
            },
            {
              inferenceProfileId:
                "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.meta.llama3-70b-instruct-v1:0",
              inferenceProfileName: "Llama 3 70B",
              status: "ACTIVE",
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
          "global.anthropic.claude-sonnet-4-6-20250514-v1:0",
          "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
        ]);
      });
    });

    describe("allowedInferenceRegions filtering", () => {
      const originalAllowedRegions = config.llm.bedrock.allowedInferenceRegions;

      afterEach(() => {
        config.llm.bedrock.allowedInferenceRegions = originalAllowedRegions;
      });

      test("filters by allowed inference regions", async () => {
        config.llm.bedrock.allowedInferenceRegions = ["us"];

        const mockResponse = {
          inferenceProfileSummaries: [
            {
              inferenceProfileId:
                "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2",
              status: "ACTIVE",
            },
            {
              inferenceProfileId:
                "global.anthropic.claude-sonnet-4-6-20250514-v1:0",
              inferenceProfileName: "Claude Sonnet 4.6",
              status: "ACTIVE",
            },
            {
              inferenceProfileId:
                "eu.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2 (EU)",
              status: "ACTIVE",
            },
          ],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        });

        const models = await fetchBedrockModels("test-api-key");

        expect(models).toHaveLength(1);
        expect(models.map((m) => m.id)).toEqual([
          "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
        ]);
      });

      test("empty allowedInferenceRegions returns all profiles", async () => {
        config.llm.bedrock.allowedInferenceRegions = [];

        const mockResponse = {
          inferenceProfileSummaries: [
            {
              inferenceProfileId:
                "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2",
              status: "ACTIVE",
            },
            {
              inferenceProfileId:
                "global.anthropic.claude-sonnet-4-6-20250514-v1:0",
              inferenceProfileName: "Claude Sonnet 4.6",
              status: "ACTIVE",
            },
            {
              inferenceProfileId:
                "eu.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2 (EU)",
              status: "ACTIVE",
            },
          ],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        });

        const models = await fetchBedrockModels("test-api-key");

        expect(models).toHaveLength(3);
      });

      test("allows multiple regions", async () => {
        config.llm.bedrock.allowedInferenceRegions = ["us", "global"];

        const mockResponse = {
          inferenceProfileSummaries: [
            {
              inferenceProfileId:
                "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2",
              status: "ACTIVE",
            },
            {
              inferenceProfileId:
                "global.anthropic.claude-sonnet-4-6-20250514-v1:0",
              inferenceProfileName: "Claude Sonnet 4.6",
              status: "ACTIVE",
            },
            {
              inferenceProfileId:
                "eu.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2 (EU)",
              status: "ACTIVE",
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
          "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
          "global.anthropic.claude-sonnet-4-6-20250514-v1:0",
        ]);
      });
    });
  });

  describe("testProviderApiKey", () => {
    test("uses config baseUrl when no override is provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ id: "deepseek-chat", created: 1700000000 }],
          }),
      });

      await testProviderApiKey("deepseek", "test-key");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${config.llm.deepseek.baseUrl}/models`);
    });

    test("uses baseUrl override when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ id: "deepseek-chat", created: 1700000000 }],
          }),
      });

      const customBaseUrl = "https://custom-proxy.example.com/v1";
      await testProviderApiKey("deepseek", "test-key", customBaseUrl);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${customBaseUrl}/models`);
      // Must NOT use the config base URL
      expect(url).not.toContain(config.llm.deepseek.baseUrl);
    });

    test("falls back to config baseUrl when override is null", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ id: "deepseek-chat", created: 1700000000 }],
          }),
      });

      await testProviderApiKey("deepseek", "test-key", null);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${config.llm.deepseek.baseUrl}/models`);
    });

    test("openai fetcher uses baseUrl override", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "gpt-4o", created: 1, object: "model", owned_by: "openai" },
            ],
          }),
      });

      const customBaseUrl = "https://my-openai-proxy.example.com/v1";
      await testProviderApiKey("openai", "test-key", customBaseUrl);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${customBaseUrl}/models`);
    });

    test("throws when API key is invalid (fetch returns error)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      await expect(
        testProviderApiKey(
          "openai",
          "bad-key",
          "https://custom.example.com/v1",
        ),
      ).rejects.toThrow();
    });
  });
});
