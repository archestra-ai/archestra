import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAnthropicNativeEndpoint } from "@/clients/anthropic-endpoint";
import { useMswServer } from "@/test/msw";

const TEST_BASE_URL = "https://llm.test/v1";

vi.mock("@/clients/anthropic-endpoint", () => ({
  isAnthropicNativeEndpoint: vi.fn().mockReturnValue(false),
}));

const mockResolveContextualRetrievalConfig = vi.hoisted(() => vi.fn());
vi.mock("./kb-llm-client", () => ({
  resolveContextualRetrievalConfig: mockResolveContextualRetrievalConfig,
}));

vi.mock("./kb-interaction", () => ({
  withKbObservability: vi.fn().mockImplementation(({ callback }) => callback()),
  getProviderChatInteractionType: vi
    .fn()
    .mockReturnValue("openai:chatCompletions"),
}));

import { buildContextualHeaders, formatContext } from "./contextual-retrieval";

const MOCK_RERANKER_CONFIG = {
  kind: "llm" as const,
  baseUrl: null,
  llmModel: createOpenAI({
    baseURL: TEST_BASE_URL,
    apiKey: "test-key",
  }).chat("gpt-4o-mini"),
  modelName: "gpt-4o-mini",
  provider: "openai" as const,
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
  title: "Quarterly engineering review",
  content:
    "The quarterly review covers several projects. Project Cedar owns the database migration.",
  chunks: ["The rollback completed after the replica lag alarm fired."],
  organizationId: "org-1",
  connectorId: null,
};

describe("buildContextualHeaders", () => {
  const server = useMswServer();

  beforeEach(() => {
    vi.mocked(isAnthropicNativeEndpoint).mockReturnValue(false);
    mockResolveContextualRetrievalConfig.mockResolvedValue({
      mode: "document",
      reranker: MOCK_RERANKER_CONFIG,
    });
  });

  it("honors a run-only disabled mode instead of the organization mode", async () => {
    const headers = await buildContextualHeaders({
      ...DOCUMENT,
      contextualRetrievalMode: "disabled",
    });

    expect(headers).toEqual([null]);
  });

  it("copies one document context onto every chunk in the cheaper mode", async () => {
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () =>
        chatCompletion(
          "Quarterly review of engineering projects, including Project Cedar.",
        ),
      ),
    );

    const headers = await buildContextualHeaders({
      ...DOCUMENT,
      chunks: ["first", "second"],
    });

    expect(headers).toEqual([
      "CONTEXT: Quarterly review of engineering projects, including Project Cedar.\n\n",
      "CONTEXT: Quarterly review of engineering projects, including Project Cedar.\n\n",
    ]);
  });

  it("batches long documents and returns a distinct context per chunk", async () => {
    mockResolveContextualRetrievalConfig.mockResolvedValue({
      mode: "chunk",
      reranker: MOCK_RERANKER_CONFIG,
    });
    const chunks = Array.from({ length: 10 }, (_, index) => `Passage ${index}`);
    const requestBodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, async ({ request }) => {
        requestBodies.push((await request.json()) as Record<string, unknown>);
        const batchStart = requestBodies.length === 1 ? 0 : 8;
        const batchLength = requestBodies.length === 1 ? 8 : 2;
        return chatCompletion(
          JSON.stringify({
            contexts: Array.from(
              { length: batchLength },
              (_, offset) => `Project ${batchStart + offset} context`,
            ),
          }),
        );
      }),
    );

    const headers = await buildContextualHeaders({ ...DOCUMENT, chunks });

    expect(requestBodies).toHaveLength(2);
    expect(headers).toHaveLength(10);
    expect(headers[0]).toBe("CONTEXT: Project 0 context\n\n");
    expect(headers[8]).toBe("CONTEXT: Project 8 context\n\n");
    expect(headers[9]).toBe("CONTEXT: Project 9 context\n\n");

    const secondPrompt = JSON.stringify(requestBodies[1]);
    expect(secondPrompt).toContain("Chunk 7; surrounding context only");
    expect(secondPrompt).toContain("Chunk 8; write context");
  });

  it("marks the stable document prefix for native Anthropic prompt caching", async () => {
    vi.mocked(isAnthropicNativeEndpoint).mockReturnValue(true);
    mockResolveContextualRetrievalConfig.mockResolvedValue({
      mode: "chunk",
      reranker: {
        kind: "llm",
        baseUrl: null,
        llmModel: createAnthropic({
          baseURL: TEST_BASE_URL,
          apiKey: "test-key",
        })("claude-haiku-4-5-20251001"),
        modelName: "claude-haiku-4-5-20251001",
        provider: "anthropic",
      },
    });
    let requestBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${TEST_BASE_URL}/messages`, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "msg-test",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                contexts: Array.from(
                  { length: 6 },
                  (_, index) => `Passage ${index} context`,
                ),
              }),
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
        });
      }),
    );

    const headers = await buildContextualHeaders({
      ...DOCUMENT,
      chunks: Array.from({ length: 6 }, (_, index) => `Passage ${index}`),
    });

    expect(headers).toHaveLength(6);
    expect(JSON.stringify(requestBody)).toContain(
      '"cache_control":{"type":"ephemeral"}',
    );
  });

  it("uses one document call for short documents even in per-passage mode", async () => {
    mockResolveContextualRetrievalConfig.mockResolvedValue({
      mode: "chunk",
      reranker: MOCK_RERANKER_CONFIG,
    });
    let callCount = 0;
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () => {
        callCount++;
        return chatCompletion("Short Project Cedar note.");
      }),
    );

    const headers = await buildContextualHeaders({
      ...DOCUMENT,
      chunks: ["one", "two", "three"],
    });

    expect(callCount).toBe(1);
    expect(new Set(headers)).toEqual(
      new Set(["CONTEXT: Short Project Cedar note.\n\n"]),
    );
  });

  it("keeps successful batches when another batch fails", async () => {
    mockResolveContextualRetrievalConfig.mockResolvedValue({
      mode: "chunk",
      reranker: MOCK_RERANKER_CONFIG,
    });
    let callCount = 0;
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json(
            { error: { message: "invalid request" } },
            { status: 400 },
          );
        }
        return chatCompletion(
          JSON.stringify({ contexts: ["Cedar rollback", "Cedar recovery"] }),
        );
      }),
    );

    const headers = await buildContextualHeaders({
      ...DOCUMENT,
      chunks: Array.from({ length: 10 }, (_, index) => `Passage ${index}`),
    });

    expect(headers.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => null));
    expect(headers.slice(8)).toEqual([
      "CONTEXT: Cedar rollback\n\n",
      "CONTEXT: Cedar recovery\n\n",
    ]);
  });

  it("does no model work when the organization disables context", async () => {
    mockResolveContextualRetrievalConfig.mockResolvedValue({
      mode: "disabled",
      reranker: null,
    });

    expect(await buildContextualHeaders(DOCUMENT)).toEqual([null]);
  });

  it("indexes without context when no generative reranker is available", async () => {
    mockResolveContextualRetrievalConfig.mockResolvedValueOnce({
      mode: "document",
      reranker: null,
    });
    expect(await buildContextualHeaders(DOCUMENT)).toEqual([null]);

    mockResolveContextualRetrievalConfig.mockResolvedValueOnce({
      mode: "chunk",
      reranker: {
        kind: "native-rerank",
        apiKey: "key",
        baseUrl: null,
        modelName: "rerank-v3.5",
        provider: "cohere",
      },
    });
    expect(await buildContextualHeaders(DOCUMENT)).toEqual([null]);
  });

  it("returns null headers for empty content without resolving settings", async () => {
    expect(
      await buildContextualHeaders({ ...DOCUMENT, content: "   " }),
    ).toEqual([null]);
    expect(mockResolveContextualRetrievalConfig).not.toHaveBeenCalled();
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
    expect(context?.length).toBeLessThan(700);
    expect(context?.endsWith("…\n\n")).toBe(true);
  });
});
