import { vi } from "vitest";
import { describe, expect, test } from "@/test";

vi.mock("@/clients/gemini-client", () => ({
  createGoogleGenAIClient: vi.fn(),
}));

import { createGoogleGenAIClient } from "@/clients/gemini-client";
import { callGeminiEmbedding, type GeminiEmbeddingError } from "./gemini";

const mockCreateGoogleGenAIClient = vi.mocked(createGoogleGenAIClient);

describe("callGeminiEmbedding", () => {
  test("embeds all texts in a single SDK call", async () => {
    const embedContent = vi.fn().mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }],
    });

    mockCreateGoogleGenAIClient.mockReturnValue({
      models: {
        embedContent,
      },
    } as never);

    const response = await callGeminiEmbedding({
      texts: ["first", "second"],
      model: "gemini-embedding-001",
      apiKey: "test-key",
      baseUrl: "https://example.test",
      dimensions: 1536,
    });

    expect(embedContent).toHaveBeenCalledTimes(1);
    expect(embedContent).toHaveBeenCalledWith({
      model: "models/gemini-embedding-001",
      contents: ["first", "second"],
      config: { outputDimensionality: 1536 },
    });
    expect(response).toEqual({
      object: "list",
      data: [
        { object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 },
        { object: "embedding", embedding: [0.4, 0.5, 0.6], index: 1 },
      ],
      model: "gemini-embedding-001",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  });

  test("throws when the SDK response does not include one embedding per input", async () => {
    const embedContent = vi.fn().mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    });

    mockCreateGoogleGenAIClient.mockReturnValue({
      models: {
        embedContent,
      },
    } as never);

    await expect(
      callGeminiEmbedding({
        texts: ["first", "second"],
        model: "gemini-embedding-001",
        apiKey: "test-key",
      }),
    ).rejects.toThrow(
      "Gemini embedding response did not include embeddings for each input",
    );
  });

  test("wraps SDK errors as GeminiEmbeddingError", async () => {
    const embedContent = vi.fn().mockRejectedValue({
      status: 429,
      message: "Rate limited",
    });

    mockCreateGoogleGenAIClient.mockReturnValue({
      models: {
        embedContent,
      },
    } as never);

    await expect(
      callGeminiEmbedding({
        texts: ["first"],
        model: "gemini-embedding-001",
        apiKey: "test-key",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GeminiEmbeddingError>>({
        name: "GeminiEmbeddingError",
        status: 429,
        message: "Rate limited",
      }),
    );
  });
});
