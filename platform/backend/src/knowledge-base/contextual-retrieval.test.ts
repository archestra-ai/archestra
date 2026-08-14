import { createOpenAI } from "@ai-sdk/openai";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    kb: { contextualRetrievalEnabled: true },
  }),
);

// The mocked module exports the same object the code under test reads, so
// toggling a field here is visible to it.
import config from "@/config";
import {
  buildChunkContexts,
  buildDocumentContext,
  formatContext,
} from "./contextual-retrieval";

const MOCK_RERANKER_CONFIG = {
  kind: "llm" as const,
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

const DOCUMENT = {
  title: "Rate limiter runbook",
  content: "The limit was raised to 5,000 per minute after the March incident.",
  organizationId: "org-1",
  connectorId: null,
};

describe("buildDocumentContext", () => {
  const server = useMswServer();

  it("returns the model's context wrapped as a chunk header", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () =>
        chatCompletion("Runbook for the billing API rate limiter."),
      ),
    );

    const context = await buildDocumentContext(DOCUMENT);

    expect(context).toBe(
      "CONTEXT: Runbook for the billing API rate limiter.\n\n",
    );
  });

  it("returns null when contextual retrieval is disabled", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);
    config.kb.contextualRetrievalEnabled = false;

    try {
      expect(await buildDocumentContext(DOCUMENT)).toBeNull();
      // Off means no work at all — not even resolving the model.
      expect(mockResolveRerankerConfig).not.toHaveBeenCalled();
    } finally {
      config.kb.contextualRetrievalEnabled = true;
    }
  });

  it("returns null when no reranking model is configured", async () => {
    mockResolveRerankerConfig.mockResolvedValue(null);

    expect(await buildDocumentContext(DOCUMENT)).toBeNull();
  });

  it("returns null for a rerank-only model, which cannot generate text", async () => {
    mockResolveRerankerConfig.mockResolvedValue({
      kind: "native-rerank",
      model: "rerank-v3.5",
      provider: "cohere",
    });

    expect(await buildDocumentContext(DOCUMENT)).toBeNull();
  });

  it("degrades to null when the LLM call fails, rather than failing ingest", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);
    server.use(
      http.post(
        `${TEST_BASE_URL}/chat/completions`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    expect(await buildDocumentContext(DOCUMENT)).toBeNull();
  });

  it("returns null for an empty document without calling the model", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    expect(
      await buildDocumentContext({ ...DOCUMENT, content: "   " }),
    ).toBeNull();
    expect(mockResolveRerankerConfig).not.toHaveBeenCalled();
  });
});

describe("formatContext", () => {
  it("treats an empty response the same as no context", () => {
    expect(formatContext(undefined)).toBeNull();
    expect(formatContext("   ")).toBeNull();
  });

  it("caps an over-long context so it cannot dilute the chunk's own terms", () => {
    const context = formatContext("x".repeat(2000));

    expect(context).not.toBeNull();
    // Prefix + 600 chars + ellipsis + trailing blank line.
    expect(context?.length).toBeLessThan(700);
    expect(context?.endsWith("…\n\n")).toBe(true);
  });
});

describe("buildChunkContexts", () => {
  const server = useMswServer();

  const CHUNKS = Array.from({ length: 10 }, (_, i) => `Chunk content ${i}`);
  const DOCUMENT_CHUNKS = { ...DOCUMENT, chunks: CHUNKS };

  beforeEach(() => {
    config.kb.contextualRetrievalEnabled = true;
    config.kb.perChunkContextualRetrievalEnabled = true;
  });

  it("returns individual contexts for each chunk using batching", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    // We expect 2 batches (10 chunks, batch size 8)
    let callCount = 0;
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () => {
        callCount++;
        if (callCount === 1) {
          // First batch: chunks 0 to 7
          return chatCompletion(
            Array.from(
              { length: 8 },
              (_, i) => `[Chunk ${i}] Context for ${i}`,
            ).join("\n"),
          );
        } else {
          // Second batch: chunks 8 to 9
          return chatCompletion(
            Array.from(
              { length: 2 },
              (_, i) => `[Chunk ${8 + i}] Context for ${8 + i}`,
            ).join("\n"),
          );
        }
      }),
    );

    const contexts = await buildChunkContexts(DOCUMENT_CHUNKS);

    expect(callCount).toBe(2);
    expect(contexts).toHaveLength(10);
    expect(contexts[0]).toBe("CONTEXT: Context for 0\n\n");
    expect(contexts[7]).toBe("CONTEXT: Context for 7\n\n");
    expect(contexts[9]).toBe("CONTEXT: Context for 9\n\n");
  });

  it("treats an unprefixed line as a wrapped continuation of the current chunk, and leaves chunks the model never mentioned as null", async () => {
    mockResolveRerankerConfig.mockResolvedValue(MOCK_RERANKER_CONFIG);

    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () => {
        // "Some garbage" has no [Chunk N] prefix, so it is folded into chunk
        // 0's context as a wrapped second line — this is indistinguishable
        // from a real multi-line blurb. Chunk 1 has no marker at all and
        // stays null.
        return chatCompletion(
          `[Chunk 0] Context 0\nSome garbage\n[Chunk 2] Context 2`,
        );
      }),
    );

    const contexts = await buildChunkContexts({
      ...DOCUMENT_CHUNKS,
      chunks: ["0", "1", "2", "3", "4", "5", "6", "7"],
    });

    expect(contexts[0]).toBe("CONTEXT: Context 0 Some garbage\n\n");
    expect(contexts[1]).toBeNull();
    expect(contexts[2]).toBe("CONTEXT: Context 2\n\n");
    expect(contexts[3]).toBeNull();
  });

  it("returns array of nulls when per-chunk context is disabled", async () => {
    config.kb.perChunkContextualRetrievalEnabled = false;

    const contexts = await buildChunkContexts(DOCUMENT_CHUNKS);

    expect(contexts).toHaveLength(10);
    expect(contexts.every((c) => c === null)).toBe(true);
    expect(mockResolveRerankerConfig).not.toHaveBeenCalled();
  });

  it("returns array of nulls when document has too few chunks", async () => {
    // 3 chunks is less than MIN_CHUNKS_FOR_PER_CHUNK (6)
    const contexts = await buildChunkContexts({
      ...DOCUMENT_CHUNKS,
      chunks: ["0", "1", "2"],
    });

    expect(contexts).toHaveLength(3);
    expect(contexts.every((c) => c === null)).toBe(true);
    expect(mockResolveRerankerConfig).not.toHaveBeenCalled();
  });
});
