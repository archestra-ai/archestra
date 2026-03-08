import { describe, expect, it, vi } from "vitest";
import type { VectorSearchResult } from "@/models/kb-chunk";
import rerank from "./reranker";

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({
    chat: () => "mock-model",
  }),
}));

const mockGenerateObject = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  generateObject: mockGenerateObject,
}));

function makeChunk(id: string, content: string): VectorSearchResult {
  return {
    id,
    content,
    chunkIndex: 0,
    documentId: `doc-${id}`,
    title: `Title ${id}`,
    sourceUrl: null,
    metadata: null,
    connectorType: null,
    score: 0.5,
  };
}

describe("rerank", () => {
  it("reorders chunks based on LLM scores", async () => {
    const chunks = [
      makeChunk("a", "low relevance"),
      makeChunk("b", "high relevance"),
      makeChunk("c", "medium relevance"),
    ];

    mockGenerateObject.mockResolvedValueOnce({
      object: {
        scores: [
          { index: 0, score: 4 },
          { index: 1, score: 9 },
          { index: 2, score: 5 },
        ],
      },
    });

    const result = await rerank({
      queryText: "test query",
      chunks,
      openaiApiKey: "test-key",
    });

    expect(result.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("filters out chunks below minimum relevance score", async () => {
    const chunks = [
      makeChunk("a", "irrelevant"),
      makeChunk("b", "relevant"),
      makeChunk("c", "also irrelevant"),
    ];

    mockGenerateObject.mockResolvedValueOnce({
      object: {
        scores: [
          { index: 0, score: 1 },
          { index: 1, score: 8 },
          { index: 2, score: 2 },
        ],
      },
    });

    const result = await rerank({
      queryText: "test query",
      chunks,
      openaiApiKey: "test-key",
    });

    expect(result.map((r) => r.id)).toEqual(["b"]);
  });

  it("returns original order on LLM error (graceful degradation)", async () => {
    const chunks = [makeChunk("a", "first"), makeChunk("b", "second")];

    mockGenerateObject.mockRejectedValueOnce(new Error("API error"));

    const result = await rerank({
      queryText: "test query",
      chunks,
      openaiApiKey: "test-key",
    });

    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns empty array for empty chunks (no LLM call)", async () => {
    const result = await rerank({
      queryText: "test query",
      chunks: [],
      openaiApiKey: "test-key",
    });

    expect(result).toEqual([]);
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });
});
