import { vi } from "vitest";
import { z } from "zod";
import { beforeEach, describe, expect, test } from "@/test";
import { fetchModelsWithBearerAuth } from "./openai-compatible";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("fetchModelsWithBearerAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  test("validates and returns data with the provided schema", async () => {
    const schema = z.object({
      data: z.array(z.object({ id: z.string(), created: z.number() })),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "model-a", created: 1715367049 }],
        }),
    });

    const result = await fetchModelsWithBearerAuth({
      url: "https://provider.example/models",
      apiKey: "test-api-key",
      errorLabel: "Test models",
      extraHeaders: { "X-Test": "yes" },
      schema,
    });

    expect(mockFetch).toHaveBeenCalledWith("https://provider.example/models", {
      headers: {
        "X-Test": "yes",
        Authorization: "Bearer test-api-key",
      },
    });
    expect(result.data[0].created).toBe(1715367049);
  });

  test("preserves generic-only behavior when no schema is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "model-a" }],
        }),
    });

    const result = await fetchModelsWithBearerAuth<{
      data: Array<{ id: string }>;
    }>({
      url: "https://provider.example/models",
      apiKey: "test-api-key",
      errorLabel: "Test models",
    });

    expect(result).toEqual({ data: [{ id: "model-a" }] });
  });

  test("rejects when schema validation fails", async () => {
    const schema = z.object({
      data: z.array(z.object({ id: z.string() })),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: 123 }],
        }),
    });

    await expect(
      fetchModelsWithBearerAuth({
        url: "https://provider.example/models",
        apiKey: "test-api-key",
        errorLabel: "Test models",
        schema,
      }),
    ).rejects.toThrow(z.ZodError);
  });

  test("preserves HTTP error behavior", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Invalid API key"),
    });

    await expect(
      fetchModelsWithBearerAuth<{ data: unknown[] }>({
        url: "https://provider.example/models",
        apiKey: "invalid-key",
        errorLabel: "Test models",
      }),
    ).rejects.toThrow("Failed to fetch Test models: 401");
  });
});
