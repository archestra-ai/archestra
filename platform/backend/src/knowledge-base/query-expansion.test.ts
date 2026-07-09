import { createOpenAI } from "@ai-sdk/openai";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { useMswServer } from "@/test/msw";

const TEST_BASE_URL = "https://llm.test/v1";

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

let server: ReturnType<typeof useMswServer>;

const MOCK_RERANKER_CONFIG = {
  llmModel: createOpenAI({
    baseURL: TEST_BASE_URL,
    apiKey: "test-key",
  }).chat("gpt-4o-mini"),
  modelName: "gpt-4o-mini",
  provider: "openai",
};

function chatCompletion(content: string) {
  return HttpResponse.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

// expandQuery fires the semantic-rephrase and keyword-expansion calls in
// parallel, so the handler routes by system prompt instead of call order (the
// old sequential mockResolvedValueOnce ordering). Each side takes either the
// text the provider should return, or `{ fail: true }` for a non-retryable
// error (replaces the old rejected generateText mock).
function serveExpansion(opts: {
  semantic: string | { fail: true };
  keyword: string | { fail: true };
}) {
  server.use(
    http.post(`${TEST_BASE_URL}/chat/completions`, async ({ request }) => {
      const body = (await request.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      const system =
        body.messages.find((m) => m.role === "system")?.content ?? "";
      const spec = system.includes("BM25") ? opts.keyword : opts.semantic;
      if (typeof spec !== "string") {
        return HttpResponse.json(
          { error: { message: "LLM error" } },
          { status: 400 },
        );
      }
      return chatCompletion(spec);
    }),
  );
}

describe("expandQuery", () => {
  server = useMswServer();

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

    serveExpansion({
      semantic: "improved semantic query",
      keyword: "keyword one\nkeyword two\nkeyword three",
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

    serveExpansion({
      // Semantic rephrase returns same as original (case-insensitive)
      semantic: "Test Query",
      // Keywords include a duplicate
      keyword: "unique keyword\ntest query",
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

    serveExpansion({
      // Semantic rephrase fails
      semantic: { fail: true },
      // Keywords succeed
      keyword: "keyword one\nkeyword two",
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

    serveExpansion({
      // Semantic rephrase succeeds
      semantic: "rephrased query",
      // Keywords fail
      keyword: { fail: true },
    });

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

    serveExpansion({
      semantic: "rephrased",
      keyword: "kw1\nkw2\nkw3\nkw4\nkw5",
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

    serveExpansion({
      semantic: "",
      keyword: "keyword one",
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

    serveExpansion({
      semantic: "rephrased",
      keyword: "kw1\n\n  \nkw2\n",
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
