import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { fetchOpenrouterModels } from "./openrouter";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("fetchOpenrouterModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  test("fetches generation and embedding models with bearer auth and extra headers", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ id: "openrouter/auto", created: 1715367049 }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "openai/text-embedding-3-small",
                name: "Text Embedding 3 Small",
                created: 1692901234,
              },
            ],
          }),
      });

    const models = await fetchOpenrouterModels(
      "test-api-key",
      "https://openrouter.example/api/v1",
      { "HTTP-Referer": "https://app.example" },
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://openrouter.example/api/v1/models",
      {
        headers: {
          "HTTP-Referer": "https://app.example",
          Authorization: "Bearer test-api-key",
        },
      },
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://openrouter.example/api/v1/embeddings/models",
      {
        headers: {
          "HTTP-Referer": "https://app.example",
          Authorization: "Bearer test-api-key",
        },
      },
    );

    expect(models).toEqual([
      {
        id: "openrouter/auto",
        displayName: "openrouter/auto",
        provider: "openrouter",
        createdAt: new Date(1715367049 * 1000).toISOString(),
      },
      {
        id: "openai/text-embedding-3-small",
        displayName: "Text Embedding 3 Small",
        provider: "openrouter",
        createdAt: new Date(1692901234 * 1000).toISOString(),
      },
    ]);
  });

  test("returns generation models when embedding model fetch fails", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ id: "openrouter/auto" }],
          }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not found"),
      });

    await expect(fetchOpenrouterModels("test-api-key")).resolves.toEqual([
      {
        id: "openrouter/auto",
        displayName: "openrouter/auto",
        provider: "openrouter",
        createdAt: undefined,
      },
    ]);
  });

  test("rejects when generation model fetch fails", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Invalid API key"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

    await expect(fetchOpenrouterModels("invalid-key")).rejects.toThrow(
      "Failed to fetch OpenRouter models: 401",
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("captures pricing, context length and tool calling from /models", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "openai/gpt-4o-mini",
                name: "GPT-4o mini",
                context_length: 128000,
                pricing: {
                  prompt: "0.00000015",
                  completion: "0.0000006",
                  input_cache_read: "0.000000075",
                  input_cache_write: "0.0000001875",
                },
                supported_parameters: ["tools", "tool_choice", "max_tokens"],
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

    const [model] = await fetchOpenrouterModels("test-api-key");

    expect(model.displayName).toBe("GPT-4o mini");
    expect(model.capabilities).toEqual({
      contextLength: 128000,
      supportsToolCalling: true,
      promptPricePerToken: "0.00000015",
      completionPricePerToken: "0.0000006",
      cacheReadPricePerToken: "0.000000075",
      cacheWritePricePerToken: "0.0000001875",
    });
  });

  test("marks :free models as zero-priced and detects missing tool calling", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "deepseek/deepseek-chat-v3.1:free",
                context_length: 64000,
                pricing: { prompt: "0", completion: "0" },
                supported_parameters: ["max_tokens"],
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

    const [model] = await fetchOpenrouterModels("test-api-key");

    expect(model.capabilities).toEqual({
      contextLength: 64000,
      supportsToolCalling: false,
      promptPricePerToken: "0",
      completionPricePerToken: "0",
      cacheReadPricePerToken: null,
      cacheWritePricePerToken: null,
    });
  });

  test("normalizes negative dynamic-router pricing to unknown", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "openrouter/auto",
                context_length: 2000000,
                pricing: { prompt: "-1", completion: "-1" },
                supported_parameters: ["tools"],
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

    const [model] = await fetchOpenrouterModels("test-api-key");

    expect(model.capabilities).toEqual({
      contextLength: 2000000,
      supportsToolCalling: true,
      promptPricePerToken: null,
      completionPricePerToken: null,
      cacheReadPricePerToken: null,
      cacheWritePricePerToken: null,
    });
  });

  test("leaves capabilities undefined when /models carries no metadata", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "openrouter/auto" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

    const [model] = await fetchOpenrouterModels("test-api-key");

    expect(model.capabilities).toBeUndefined();
  });
});
