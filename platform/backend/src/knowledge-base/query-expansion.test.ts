import { describe, expect, it, vi } from "vitest";

const mockGenerateText = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    text: "rephrased query text",
    usage: { promptTokens: 10, completionTokens: 5 },
  }),
);

vi.mock("ai", () => ({
  generateText: mockGenerateText,
}));

const mockResolveRerankerConfig = vi.hoisted(() => vi.fn());
vi.mock("./kb-llm-client", () => ({
  resolveRerankerConfig: mockResolveRerankerConfig,
}));

vi.mock("./kb-interaction", () => ({
  withKbObservability: vi.fn().mockImplementation(({ callback }) => callback()),
  getProviderChatInteractionType: vi
    .fn()
    .mockReturnValue("openai:chatCompletions"),
}));

import { expandQuery } from "./query-expansion";

const MOCK_RERANKER_CONFIG = {
  llmModel: {},
  modelName: "gpt-4o-mini",
  provider: "openai",
};

describe("expandQuery", () => {
  it("returns single query when no reranker config", async () => {
    mockResolveRerankerConfig.mockResolvedValue(null);

    const result = await expandQuery({
      queryText: "test query",
      organizationId: "org-1",
    });

    expect(result).toEqual([
      { queryText: "test query", weight: 1.0, type: "semantic" },
    ]);
  });

  it("returns expanded queries on success", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    // First call: semantic rephrase
    mockGenerateText.mockResolvedValueOnce({
      text: "improved semantic query",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    // Second call: keyword expansion
    mockGenerateText.mockResolvedValueOnce({
      text: "keyword one\nkeyword two\nkeyword three",
      usage: { promptTokens: 10, completionTokens: 8 },
    });

    const result = await expandQuery({
      queryText: "test query",
      organizationId: "org-1",
    });

    expect(result).toHaveLength(5); // original + semantic + 3 keywords
    expect(result[0]).toEqual({
      queryText: "test query",
      weight: 0.5,
      type: "semantic",
    });
    expect(result[1]).toEqual({
      queryText: "improved semantic query",
      weight: 1.3,
      type: "semantic",
    });
    expect(result[2]).toEqual({
      queryText: "keyword one",
      weight: 1.0,
      type: "keyword",
    });
    expect(result[3]).toEqual({
      queryText: "keyword two",
      weight: 1.0,
      type: "keyword",
    });
    expect(result[4]).toEqual({
      queryText: "keyword three",
      weight: 1.0,
      type: "keyword",
    });
  });

  it("deduplicates queries case-insensitively and sums weights", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    // Semantic rephrase returns same as original (case-insensitive)
    mockGenerateText.mockResolvedValueOnce({
      text: "Test Query",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    // Keywords include a duplicate
    mockGenerateText.mockResolvedValueOnce({
      text: "unique keyword\ntest query",
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    const result = await expandQuery({
      queryText: "test query",
      organizationId: "org-1",
    });

    // "test query" appears 3 times (original 0.5 + semantic 1.3 + keyword 1.0 = 2.8)
    const testQueryEntry = result.find(
      (q) => q.queryText.toLowerCase() === "test query",
    );
    expect(testQueryEntry?.weight).toBeCloseTo(2.8);

    const uniqueKeyword = result.find((q) => q.queryText === "unique keyword");
    expect(uniqueKeyword).toBeDefined();
    expect(uniqueKeyword?.weight).toBe(1.0);
  });

  it("handles semantic rephrase failure gracefully", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    // Semantic rephrase fails
    mockGenerateText.mockRejectedValueOnce(new Error("LLM error"));
    // Keywords succeed
    mockGenerateText.mockResolvedValueOnce({
      text: "keyword one\nkeyword two",
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    const result = await expandQuery({
      queryText: "test query",
      organizationId: "org-1",
    });

    // original + 2 keywords (no semantic rephrase)
    expect(result).toHaveLength(3);
    expect(result[0].queryText).toBe("test query");
    expect(result[0].weight).toBe(0.5);
  });

  it("handles keyword expansion failure gracefully", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    // Semantic rephrase succeeds
    mockGenerateText.mockResolvedValueOnce({
      text: "rephrased query",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    // Keywords fail
    mockGenerateText.mockRejectedValueOnce(new Error("LLM error"));

    const result = await expandQuery({
      queryText: "test query",
      organizationId: "org-1",
    });

    // original + semantic rephrase (no keywords)
    expect(result).toHaveLength(2);
    expect(result[0].queryText).toBe("test query");
    expect(result[1].queryText).toBe("rephrased query");
  });

  it("caps keyword queries at 3", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    mockGenerateText.mockResolvedValueOnce({
      text: "rephrased",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    mockGenerateText.mockResolvedValueOnce({
      text: "kw1\nkw2\nkw3\nkw4\nkw5",
      usage: { promptTokens: 10, completionTokens: 10 },
    });

    const result = await expandQuery({
      queryText: "test query",
      organizationId: "org-1",
    });

    const keywords = result.filter((q) => q.type === "keyword");
    expect(keywords).toHaveLength(3);
  });

  it("handles empty semantic rephrase response", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    mockGenerateText.mockResolvedValueOnce({
      text: "",
      usage: { promptTokens: 10, completionTokens: 0 },
    });
    mockGenerateText.mockResolvedValueOnce({
      text: "keyword one",
      usage: { promptTokens: 10, completionTokens: 3 },
    });

    const result = await expandQuery({
      queryText: "test query",
      organizationId: "org-1",
    });

    // original + 1 keyword (empty semantic response ignored)
    expect(result).toHaveLength(2);
    expect(result[0].queryText).toBe("test query");
    expect(result[1].queryText).toBe("keyword one");
  });

  it("filters empty lines from keyword response", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    mockGenerateText.mockResolvedValueOnce({
      text: "rephrased",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    mockGenerateText.mockResolvedValueOnce({
      text: "kw1\n\n  \nkw2\n",
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    const result = await expandQuery({
      queryText: "test query",
      organizationId: "org-1",
    });

    const keywords = result.filter((q) => q.type === "keyword");
    expect(keywords).toHaveLength(2);
    expect(keywords[0].queryText).toBe("kw1");
    expect(keywords[1].queryText).toBe("kw2");
  });
});
