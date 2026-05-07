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
});
