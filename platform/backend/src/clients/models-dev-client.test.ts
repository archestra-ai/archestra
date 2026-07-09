import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelModel } from "@/models";
import type {
  ModelsDevApiResponse,
  ModelsDevModel,
  ModelsDevProvider,
} from "./models-dev-client";

// Use vi.hoisted to create mock functions that can be used in vi.mock factory
const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

// Mock global fetch. The config's `unstubGlobals` removes stubs after every
// test, so re-apply before each one; the top-level stub covers import time.
vi.stubGlobal("fetch", mockFetch);
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

// Import after mock is defined
import {
  ModelsDevClient,
  modelsDevClient,
  sanitizeOutputLimit,
} from "./models-dev-client";

// The canonical Map-backed fake from src/__mocks__/cache-manager.ts avoids
// "CacheManager: Not started" errors; the store resets before every test.
vi.mock("@/cache-manager");

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
    // The singleton caches fetched responses in memory; clear between tests
    // so each case controls its own fetch behavior.
    modelsDevClient.clearFetchCache();
  });

  afterEach(async () => {
    await ModelModel.deleteAll();
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

  describe("fetch caching", () => {
    function mockSuccessfulFetchOnce(response: ModelsDevApiResponse) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });
    }

    test("second call within TTL reuses the cached response", async () => {
      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({ id: "gpt-4o", name: "GPT-4o" }),
        }),
      });
      mockSuccessfulFetchOnce(mockResponse);

      const first = await modelsDevClient.fetchModelsFromApi();
      const second = await modelsDevClient.fetchModelsFromApi();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
      expect(second.openai.models["gpt-4o"].name).toBe("GPT-4o");
    });

    test("refetches after the cache TTL expires", async () => {
      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({ id: "gpt-4o", name: "GPT-4o" }),
        }),
      });
      mockSuccessfulFetchOnce(mockResponse);
      await modelsDevClient.fetchModelsFromApi();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.advanceTimersByTime(6 * 60 * 1000);
        mockSuccessfulFetchOnce(mockResponse);
        await modelsDevClient.fetchModelsFromApi();
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test("concurrent calls share a single in-flight fetch", async () => {
      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({ id: "gpt-4o", name: "GPT-4o" }),
        }),
      });
      let resolveFetch!: (value: unknown) => void;
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );

      const firstCall = modelsDevClient.fetchModelsFromApi();
      const secondCall = modelsDevClient.fetchModelsFromApi();
      resolveFetch({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });
      const [first, second] = await Promise.all([firstCall, secondCall]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(first.openai.models["gpt-4o"].name).toBe("GPT-4o");
    });

    test("does not cache the empty error result", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network Error"));

      const failed = await modelsDevClient.fetchModelsFromApi();
      expect(failed).toEqual({});

      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({ id: "gpt-4o", name: "GPT-4o" }),
        }),
      });
      mockSuccessfulFetchOnce(mockResponse);

      const recovered = await modelsDevClient.fetchModelsFromApi();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(recovered.openai).toBeDefined();
    });

    test("does not cache the raw fallback when schema validation fails", async () => {
      // A provider value that is not an object fails schema validation; the
      // raw fallback is returned but not cached, so a retry refetches instead
      // of reusing a potentially malformed payload for the whole TTL.
      const invalidPayload = { openai: "not-a-provider-object" };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(invalidPayload),
      });

      const first = await modelsDevClient.fetchModelsFromApi();
      const second = await modelsDevClient.fetchModelsFromApi();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(first).toEqual(invalidPayload);
      expect(second).toEqual(invalidPayload);
    });
  });

  describe("fetch timeout", () => {
    test("aborts a hanging fetch and returns an empty result", async () => {
      const client = new ModelsDevClient({ fetchTimeoutMs: 10 });
      mockFetch.mockImplementationOnce(
        (_url: string, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () =>
              reject(options.signal.reason),
            );
          }),
      );

      const result = await client.fetchModelsFromApi();

      expect(result).toEqual({});
      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
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
      expect(modelsDevClient.mapProvider("deepseek")).toBe("deepseek");
      expect(modelsDevClient.mapProvider("openrouter")).toBe("openrouter");
      expect(modelsDevClient.mapProvider("xai")).toBe("xai");
    });

    test("maps OpenAI-compatible providers to openai", () => {
      expect(modelsDevClient.mapProvider("llama")).toBe("openai");
      expect(modelsDevClient.mapProvider("groq")).toBe("groq");
      expect(modelsDevClient.mapProvider("openrouter")).toBe("openrouter");
      expect(modelsDevClient.mapProvider("fireworks-ai")).toBe("openai");
      expect(modelsDevClient.mapProvider("togetherai")).toBe("openai");
    });

    test("returns null for explicitly unsupported providers", () => {
      expect(modelsDevClient.mapProvider("perplexity")).toBeNull();
      expect(modelsDevClient.mapProvider("nvidia")).toBeNull();
      expect(modelsDevClient.mapProvider("amazon-bedrock")).toBeNull();
      expect(modelsDevClient.mapProvider("azure")).toBeNull();
    });

    test("returns null for unknown providers", () => {
      expect(modelsDevClient.mapProvider("unknown-provider")).toBeNull();
    });
  });

  describe("convertToModel", () => {
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

      const result = modelsDevClient.convertToModel("openai", model);

      expect(result).not.toBeNull();
      expect(result?.externalId).toBe("openai/gpt-4o");
      expect(result?.provider).toBe("openai");
      expect(result?.modelId).toBe("gpt-4o");
      expect(result?.description).toBe("GPT-4o");
      expect(result?.contextLength).toBe(128000);
      expect(result?.outputLength).toBe(16384);
      expect(result?.inputModalities).toEqual(["text", "image", "pdf"]);
      expect(result?.outputModalities).toEqual(["text"]);
      expect(result?.supportsToolCalling).toBe(true);
      expect(Number(result?.promptPricePerToken)).toBeCloseTo(0.000005);
      expect(Number(result?.completionPricePerToken)).toBeCloseTo(0.000015);
    });

    test("returns null for unsupported provider", () => {
      const model = createMockModel({ id: "test-model", name: "Test" });
      const result = modelsDevClient.convertToModel("perplexity", model);
      expect(result).toBeNull();
    });

    test("defaults to text modality when modalities are empty", () => {
      const model = createMockModel({
        id: "test-model",
        modalities: { input: [], output: [] },
      });

      const result = modelsDevClient.convertToModel("openai", model);

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

      const result = modelsDevClient.convertToModel("openai", model);

      expect(result?.inputModalities).toEqual(["text", "image"]);
      expect(result?.outputModalities).toEqual(["text"]);
    });

    test("handles missing cost data", () => {
      const model = createMockModel({
        id: "test-model",
        cost: undefined,
      });

      const result = modelsDevClient.convertToModel("openai", model);

      expect(result?.promptPricePerToken).toBeNull();
      expect(result?.completionPricePerToken).toBeNull();
    });

    test("handles missing context length", () => {
      const model = createMockModel({
        id: "test-model",
        limit: undefined,
      });

      const result = modelsDevClient.convertToModel("openai", model);

      expect(result?.contextLength).toBeNull();
      expect(result?.outputLength).toBeNull();
    });

    test("drops an invalid output limit to null", () => {
      const model = createMockModel({
        id: "test-model",
        limit: { context: 128000, output: 0 },
      });

      const result = modelsDevClient.convertToModel("openai", model);

      expect(result?.outputLength).toBeNull();
    });
  });

  describe("sanitizeOutputLimit", () => {
    test("keeps positive integers", () => {
      expect(sanitizeOutputLimit(16384)).toBe(16384);
      expect(sanitizeOutputLimit(1)).toBe(1);
    });

    test("drops zero, negative, non-integer, null and undefined", () => {
      expect(sanitizeOutputLimit(0)).toBeNull();
      expect(sanitizeOutputLimit(-100)).toBeNull();
      expect(sanitizeOutputLimit(1.5)).toBeNull();
      expect(sanitizeOutputLimit(Number.NaN)).toBeNull();
      expect(sanitizeOutputLimit(Number.POSITIVE_INFINITY)).toBeNull();
      expect(sanitizeOutputLimit(null)).toBeNull();
      expect(sanitizeOutputLimit(undefined)).toBeNull();
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
        openrouter: createMockProvider("openrouter", {
          "anthropic/claude-3.5-sonnet": createMockModel({
            id: "anthropic/claude-3.5-sonnet",
            name: "Anthropic Claude 3.5 Sonnet",
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

      // Should sync 3 models (openai + anthropic + openrouter), not perplexity
      expect(count).toBe(3);

      const openaiMetadata = await ModelModel.findByProviderAndModelId(
        "openai",
        "gpt-4o",
      );
      expect(openaiMetadata).not.toBeNull();
      expect(openaiMetadata?.description).toBe("GPT-4o");

      const anthropicMetadata = await ModelModel.findByProviderAndModelId(
        "anthropic",
        "claude-3-5-sonnet",
      );
      expect(anthropicMetadata).not.toBeNull();

      const openrouterMetadata = await ModelModel.findByProviderAndModelId(
        "openrouter",
        "anthropic/claude-3.5-sonnet",
      );
      expect(openrouterMetadata).not.toBeNull();
      expect(openrouterMetadata?.description).toBe(
        "Anthropic Claude 3.5 Sonnet",
      );
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

      const metadata = await ModelModel.findByProviderAndModelId(
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

      const metadata = await ModelModel.findByProviderAndModelId(
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

      const gpt4Metadata = await ModelModel.findByProviderAndModelId(
        "openai",
        "gpt-4o",
      );
      expect(gpt4Metadata?.supportsToolCalling).toBe(true);

      const instructMetadata = await ModelModel.findByProviderAndModelId(
        "openai",
        "gpt-3.5-turbo-instruct",
      );
      expect(instructMetadata?.supportsToolCalling).toBe(false);
    });
  });

  describe("API response validation", () => {
    test("handles valid API response", async () => {
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

      expect(result.openai).toBeDefined();
      expect(result.openai.models["gpt-4o"]).toBeDefined();
    });

    test("handles API response with extra fields gracefully", async () => {
      // Simulate API response with additional unexpected fields
      const mockResponse = {
        openai: {
          id: "openai",
          name: "OpenAI",
          npm: "@ai-sdk/openai",
          env: ["OPENAI_API_KEY"],
          models: {
            "gpt-4o": {
              id: "gpt-4o",
              name: "GPT-4o",
              // Extra field not in schema
              new_field: "some value",
              modalities: { input: ["text"], output: ["text"] },
            },
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await modelsDevClient.fetchModelsFromApi();

      // Should still parse successfully (Zod strips unknown keys by default)
      expect(result.openai).toBeDefined();
    });
  });

  describe("syncIfNeeded with retry", () => {
    test("calls syncModelMetadata in background", async () => {
      const mockResponse = createMockApiResponse({
        openai: createMockProvider("openai", {
          "gpt-4o": createMockModel({ id: "gpt-4o", name: "GPT-4o" }),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      // syncIfNeeded is non-blocking, so we need to wait a bit
      modelsDevClient.syncIfNeeded();

      // Wait for async operation to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
