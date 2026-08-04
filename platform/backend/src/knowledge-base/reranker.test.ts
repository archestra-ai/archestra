import { createOpenAI } from "@ai-sdk/openai";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "@/database";
import type { VectorSearchResult } from "@/models/kb-chunk";
import { useMswServer } from "@/test/msw";
import rerank from "./reranker";

const TEST_BASE_URL = "https://llm.test/v1";

const mockResolveRerankerConfig = vi.hoisted(() => vi.fn());
vi.mock("./kb-llm-client", () => ({
  resolveRerankerConfig: mockResolveRerankerConfig,
}));

let server: ReturnType<typeof useMswServer>;

// Tracks how many chat/completions requests the real AI SDK actually made, so
// the "no LLM call" cases can assert the boundary was never hit (MSW would also
// fail the test loudly on any unhandled request).
let chatCompletionCalls = 0;

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

function chatCompletion(content: string) {
  return HttpResponse.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o",
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

// Serve the reranker's structured-output call. Pass a JSON string for the
// object the SDK should surface, or `{ fail: true }` to make the provider
// return a non-retryable error (replaces the old rejected generateObject mock).
function serveScores(content: string | { fail: true }) {
  server.use(
    http.post(`${TEST_BASE_URL}/chat/completions`, () => {
      chatCompletionCalls++;
      if (typeof content !== "string") {
        return HttpResponse.json(
          { error: { message: "API error" } },
          { status: 400 },
        );
      }
      return chatCompletion(content);
    }),
  );
}

/** Reranker interactions are recorded fire-and-forget, so poll for them. */
async function waitForRerankerInteractions() {
  const read = () =>
    db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.source, "knowledge:reranker"));

  await vi.waitFor(async () => expect(await read()).toHaveLength(1));
  return read();
}

function setupRerankerConfig() {
  mockResolveRerankerConfig.mockResolvedValue({
    kind: "llm",
    llmModel: createOpenAI({
      baseURL: TEST_BASE_URL,
      apiKey: "test-key",
    }).chat("gpt-4o"),
    modelName: "gpt-4o",
    provider: "openai",
  });
}

const NATIVE_RERANK_URL =
  "https://my-resource.cognitiveservices.azure.com/providers/cohere/v2/rerank";

function setupNativeRerankerConfig() {
  mockResolveRerankerConfig.mockResolvedValue({
    kind: "native-rerank",
    apiKey: "azure-key",
    baseUrl: "https://my-resource.cognitiveservices.azure.com/openai/v1",
    modelName: "Cohere-rerank-v4.0-fast",
    provider: "azure",
  });
}

describe("rerank", () => {
  server = useMswServer();

  beforeEach(() => {
    chatCompletionCalls = 0;
  });

  it("reorders chunks based on LLM scores", async () => {
    setupRerankerConfig();
    const chunks = [
      makeChunk("a", "low relevance"),
      makeChunk("b", "high relevance"),
      makeChunk("c", "medium relevance"),
    ];

    serveScores(
      JSON.stringify({
        scores: [
          { index: 0, score: 4 },
          { index: 1, score: 9 },
          { index: 2, score: 5 },
        ],
      }),
    );

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

    serveScores(
      JSON.stringify({
        scores: [
          { index: 0, score: 1 },
          { index: 1, score: 8 },
          { index: 2, score: 2 },
        ],
      }),
    );

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

    serveScores({ fail: true });

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
    expect(chatCompletionCalls).toBe(0);
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
    expect(chatCompletionCalls).toBe(0);
  });

  it("records the connector the query was scoped to on the interaction", async () => {
    setupRerankerConfig();
    const connectorId = "3f1c9d2e-8b7a-4c6d-9e5f-1a2b3c4d5e6f";
    serveScores(JSON.stringify({ scores: [{ index: 0, score: 9 }] }));

    await rerank({
      queryText: "test query",
      chunks: [makeChunk("a", "relevant")],
      organizationId: "test-org-id",
      connectorId,
    });

    const [row] = await waitForRerankerInteractions();
    expect(row.connectorId).toBe(connectorId);
  });

  it("leaves the connector unset when the query spans several", async () => {
    setupRerankerConfig();
    serveScores(JSON.stringify({ scores: [{ index: 0, score: 9 }] }));

    await rerank({
      queryText: "test query",
      chunks: [makeChunk("a", "relevant")],
      organizationId: "test-org-id",
      connectorId: null,
    });

    const [row] = await waitForRerankerInteractions();
    expect(row.connectorId).toBeNull();
  });

  describe("native rerank models", () => {
    it("reorders and filters chunks by native relevance scores, without any LLM call", async () => {
      setupNativeRerankerConfig();
      let sentDocuments: unknown;
      server.use(
        http.post(NATIVE_RERANK_URL, async ({ request }) => {
          const body = (await request.json()) as { documents?: unknown };
          sentDocuments = body.documents;
          return HttpResponse.json({
            results: [
              { index: 1, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.4 },
              // Below RERANKER_NATIVE_MIN_RELEVANCE_SCORE (0.1) — dropped.
              { index: 2, relevance_score: 0.01 },
            ],
          });
        }),
      );

      const chunks = [
        makeChunk("a", "somewhat relevant"),
        makeChunk("b", "most relevant"),
        makeChunk("c", "irrelevant"),
      ];
      const result = await rerank({
        queryText: "test query",
        chunks,
        organizationId: "test-org-id",
      });

      expect(sentDocuments).toEqual([
        "somewhat relevant",
        "most relevant",
        "irrelevant",
      ]);
      expect(result.map((r) => r.id)).toEqual(["b", "a"]);
      expect(chatCompletionCalls).toBe(0);
    });

    it("returns original order when the rerank API fails (graceful degradation)", async () => {
      setupNativeRerankerConfig();
      server.use(
        http.post(NATIVE_RERANK_URL, () =>
          HttpResponse.json(
            { error: { message: "throttled" } },
            { status: 429 },
          ),
        ),
      );

      const chunks = [makeChunk("a", "first"), makeChunk("b", "second")];
      const result = await rerank({
        queryText: "test query",
        chunks,
        organizationId: "test-org-id",
      });

      expect(result.map((r) => r.id)).toEqual(["a", "b"]);
      expect(chatCompletionCalls).toBe(0);
    });
  });
});
