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

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    kb: { contextualRetrievalEnabled: true },
  }),
);

// The mocked module exports the same object the code under test reads, so
// toggling a field here is visible to it.
import config from "@/config";
import { buildDocumentContext, formatContext } from "./contextual-retrieval";

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
