/**
 * Lifecycle coverage for verifiable citations (issue #7161) on the default
 * chat surface: a search_and_run_only agent (the built-in My Assistant mode)
 * reaches the knowledge tool only through `run_tool`, its chunks are captured
 * into the per-turn collector the route threads into the tool layer, and the
 * check runs in the UI stream's onFinish over every text part of the turn —
 * not just the final step's text.
 */
import {
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { __test as chatToolBuilderTest } from "@/clients/chat-tool-builder";
import config from "@/config";
import type { KbChunkForQuoteCheck } from "@/knowledge-base/quote-verification";
import { reportQuoteVerification } from "@/observability/metrics/rag";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const mockCreateUIMessageStream = vi.hoisted(() => vi.fn());
const mockCreateUIMessageStreamResponse = vi.hoisted(() => vi.fn());
const mockStreamText = vi.hoisted(() => vi.fn());
const mockCreateLLMModelForAgent = vi.hoisted(() => vi.fn());
const mockGetChatMcpTools = vi.hoisted(() => vi.fn());
const mockGetChatMcpToolUiResourceUris = vi.hoisted(() => vi.fn());
const mockExtractAndIngestDocuments = vi.hoisted(() => vi.fn());
const mockStartActiveChatSpan = vi.hoisted(() => vi.fn());
const mockCompactMessagesForChat = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    createUIMessageStream: mockCreateUIMessageStream,
    createUIMessageStreamResponse: mockCreateUIMessageStreamResponse,
    streamText: mockStreamText,
    convertToModelMessages: vi.fn(async (messages) => messages),
  };
});

vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return {
    ...actual,
    createLLMModelForAgent: mockCreateLLMModelForAgent,
  };
});

vi.mock("@/clients/chat-mcp-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/chat-mcp-client")>();
  return {
    ...actual,
    getChatMcpTools: mockGetChatMcpTools,
    getChatMcpToolUiResourceUris: mockGetChatMcpToolUiResourceUris,
  };
});

vi.mock("@/knowledge-base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/knowledge-base")>();
  return {
    ...actual,
    extractAndIngestDocuments: mockExtractAndIngestDocuments,
  };
});

vi.mock("@/observability/tracing", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/observability/tracing")>();
  return {
    ...actual,
    startActiveChatSpan: mockStartActiveChatSpan,
  };
});

vi.mock("./context-compaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context-compaction")>();
  return {
    ...actual,
    compactMessagesForChat: mockCompactMessagesForChat,
  };
});

vi.mock("@/observability/metrics/rag", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/observability/metrics/rag")>();
  return {
    ...actual,
    reportQuoteVerification: vi.fn(),
  };
});

const REF = "3fa85f64-5717-4562-b3fc-2c963f66afa6#0";
const CHUNK: KbChunkForQuoteCheck = {
  ref: REF,
  content:
    'TITLE: Data Policy\n\nThe retention mode is "strict" for all accounts. The retention period is 90 days.',
};

describe("POST /api/chat quote verification lifecycle (search_and_run_only)", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;
  let capturedInnerOnFinish:
    | ((args: { messages: unknown[] }) => Promise<void> | void)
    | undefined;
  let executionPromise: Promise<void> | undefined;
  const originalQuoteVerificationEnabled = config.kb.quoteVerificationEnabled;

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      capturedInnerOnFinish = undefined;
      executionPromise = undefined;
      vi.mocked(reportQuoteVerification).mockClear();

      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;

      // The default My Assistant configuration: knowledge access only through
      // the progressive search_tools/run_tool path.
      const agent = await makeAgent({
        organizationId,
        name: "My Assistant",
        systemPrompt: "",
        toolExposureMode: "search_and_run_only",
      });
      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId,
      });
      conversationId = conversation.id;

      mockCreateLLMModelForAgent.mockResolvedValue({ model: "mock-model" });
      mockGetChatMcpTools.mockResolvedValue({});
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
      mockExtractAndIngestDocuments.mockResolvedValue(undefined);
      mockCompactMessagesForChat.mockImplementation(
        async ({ messages }: { messages: unknown[] }) => ({
          messages,
          status: "skipped",
          compaction: null,
          reason: "below_threshold",
        }),
      );
      mockStartActiveChatSpan.mockImplementation(
        async ({ callback }: { callback: () => Promise<Response> }) =>
          callback(),
      );

      mockStreamText.mockImplementation(() => ({
        toUIMessageStream: (opts: {
          onFinish?: (args: { messages: unknown[] }) => Promise<void> | void;
        }) => {
          capturedInnerOnFinish = opts.onFinish;
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
        fullStream: {
          [Symbol.asyncIterator]: () => {
            const events = [
              { type: "text-delta", text: "" },
              { type: "finish", finishReason: "stop" },
            ];
            let index = 0;
            return {
              next: async () =>
                index < events.length
                  ? { done: false, value: events[index++] }
                  : { done: true, value: undefined },
            };
          },
        },
        usage: Promise.resolve(null),
      }));

      mockCreateUIMessageStream.mockImplementation(
        ({
          execute,
        }: {
          execute: (args: {
            writer: {
              write: (x: unknown) => void;
              merge: (s: unknown) => void;
            };
          }) => Promise<void>;
        }) => {
          const writer = { write: vi.fn(), merge: vi.fn() };
          executionPromise = execute({ writer }).catch(() => undefined);
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      );

      mockCreateUIMessageStreamResponse.mockImplementation(
        ({ stream }: { stream: ReadableStream }) =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      );

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });

      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    // The disabled-feature test flips this flag, and vitest shuffles test
    // order — without a restore the other tests see the feature off.
    config.kb.quoteVerificationEnabled = originalQuoteVerificationEnabled;
    archestraMcpBranding.syncFromOrganization(null);
    await app.close();
  });

  const startTurn = async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "what is the retention policy?" }],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    await executionPromise;
  };

  /** The collector the route threaded into the tool layer for this turn. */
  const threadedCollector = (): KbChunkForQuoteCheck[] | undefined =>
    mockGetChatMcpTools.mock.calls.at(-1)?.[0]?.kbChunksCollector;

  /**
   * What the real tool wrapper does when the model's `run_tool` dispatch to
   * the knowledge tool returns: capture the raw result's chunks into the
   * turn's collector.
   */
  const simulateKbDispatch = (collector: KbChunkForQuoteCheck[]) => {
    const output = { results: [CHUNK], totalChunks: 1 };
    chatToolBuilderTest.collectKbChunksForVerification({
      ctx: { kbChunksCollector: collector },
      toolName: archestraMcpBranding.getToolName(TOOL_RUN_TOOL_SHORT_NAME),
      toolArguments: {
        tool_name: TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
        tool_args: { query: "retention" },
      },
      response: {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      },
    });
  };

  test("verifies quotes cited from a run_tool knowledge dispatch across all turn text", async () => {
    await startTurn();

    const collector = threadedCollector();
    // The route must thread a live collector into the tool layer — this is
    // what connects run_tool dispatch capture to the onFinish check.
    expect(collector).toBeDefined();
    if (!collector) throw new Error("collector not threaded");
    simulateKbDispatch(collector);
    expect(collector).toEqual([CHUNK]);

    expect(capturedInnerOnFinish).toBeDefined();
    // The fabricated quote sits in a text part BEFORE a later tool step —
    // exactly the text streamText's final-step `text` would omit. The genuine
    // quote sits after. Both must be checked.
    await capturedInnerOnFinish?.({
      messages: [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "what is the retention policy?" }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "text",
              text: `Per the policy:\n> "The retention mode is "relaxed" for all accounts." — ${REF}`,
            },
            { type: "tool-archestra__run_tool", state: "output-available" },
            {
              type: "text",
              text: `And on duration:\n> "The retention period is 90 days." — ${REF}`,
            },
          ],
        },
      ],
    });

    expect(reportQuoteVerification).toHaveBeenCalledTimes(1);
    expect(reportQuoteVerification).toHaveBeenCalledWith({
      matched: 1,
      wrongRef: 0,
      failed: 1,
      unverifiable: 0,
      unparseable: 0,
    });
  });

  test("reports nothing when the turn pulled no knowledge", async () => {
    await startTurn();
    expect(threadedCollector()).toEqual([]);

    await capturedInnerOnFinish?.({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "No knowledge used here." }],
        },
      ],
    });

    expect(reportQuoteVerification).not.toHaveBeenCalled();
  });

  test("threads no collector and runs no check when the feature is disabled", async () => {
    config.kb.quoteVerificationEnabled = false;

    await startTurn();
    expect(threadedCollector()).toBeUndefined();

    await capturedInnerOnFinish?.({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "text",
              text: `> "The retention period is 90 days." — ${REF}`,
            },
          ],
        },
      ],
    });

    expect(reportQuoteVerification).not.toHaveBeenCalled();
  });
});
