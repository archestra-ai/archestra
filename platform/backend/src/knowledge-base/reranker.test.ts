import { describe, expect, it, vi } from "vitest";
import type { VectorSearchResult } from "@/models/kb-chunk";
import rerank from "./reranker";

const mockResolveRerankerConfig = vi.hoisted(() => vi.fn());
vi.mock("./kb-llm-client", () => ({
  resolveRerankerConfig: mockResolveRerankerConfig,
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

function setupRerankerConfig() {
  mockResolveRerankerConfig.mockResolvedValue({
    llmModel: "mock-model",
    modelName: "gpt-4o",
  });
}

describe("rerank", () => {
  it("reorders chunks based on LLM scores", async () => {
    setupRerankerConfig();
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
      organizationId: "test-org-id",
    });

    expect(result.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("filters out chunks below minimum relevance score", async () => {
    setupRerankerConfig();
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
      organizationId: "test-org-id",
    });

    expect(result.map((r) => r.id)).toEqual(["b"]);
  });

  it("returns original order on LLM error (graceful degradation)", async () => {
    setupRerankerConfig();
    const chunks = [makeChunk("a", "first"), makeChunk("b", "second")];

    mockGenerateObject.mockRejectedValueOnce(new Error("API error"));

    const result = await rerank({
      queryText: "test query",
      chunks,
      organizationId: "test-org-id",
    });

    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns empty array for empty chunks (no LLM call)", async () => {
    const result = await rerank({
      queryText: "test query",
      chunks: [],
      organizationId: "test-org-id",
    });

    expect(result).toEqual([]);
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("returns original order when no reranker config is available", async () => {
    mockResolveRerankerConfig.mockResolvedValue(null);
    const chunks = [makeChunk("a", "first"), makeChunk("b", "second")];

    const result = await rerank({
      queryText: "test query",
      chunks,
      organizationId: "test-org-id",
    });

    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });
});
