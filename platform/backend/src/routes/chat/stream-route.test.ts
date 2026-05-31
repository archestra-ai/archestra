import { NoSuchToolError } from "ai";
import { vi } from "vitest";
import { MessageModel } from "@/models";
import ActiveChatRunModel from "@/models/chat-active-run";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const TEST_TRACE_CONTEXT = {
  sessionId: "session-test-123",
  traceId: "trace-test-123",
  spanId: "span-test-123",
};

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

vi.mock("./errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./errors")>();
  return {
    ...actual,
    getActiveTraceContext: vi.fn(() => TEST_TRACE_CONTEXT),
  };
});

describe("POST /api/chat slim error payload", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;

      const agent = await makeAgent({
        organizationId,
        name: "Router Agent",
        systemPrompt: "",
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
      mockCreateUIMessageStream.mockImplementation(
        ({ onError }: { onError: (error: Error) => string }) => {
          const errorPayload = onError(new Error("Failed to fetch"));
          return {
            tee: () => [
              errorPayload,
              new ReadableStream({
                start(controller) {
                  controller.close();
                },
              }),
            ],
          };
        },
      );
      mockCreateUIMessageStreamResponse.mockImplementation(
        ({ stream }: { stream: string }) =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      );

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & {
            organizationId: string;
          }
        ).organizationId = organizationId;
      });

      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("returns only mapped message and correlation ids when slim mode is enabled", async () => {
    const { default: OrganizationModel } = await import(
      "@/models/organization"
    );
    await OrganizationModel.patch(organizationId, {
      slimChatErrorUi: true,
      chatErrorSupportMessage: "Contact support",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      code: "unknown",
      message: "An unexpected error occurred. Please try again.",
      isRetryable: false,
      sessionId: TEST_TRACE_CONTEXT.sessionId,
      traceId: TEST_TRACE_CONTEXT.traceId,
      spanId: TEST_TRACE_CONTEXT.spanId,
    });
  });
});

describe("POST /api/chat toUIMessageStream onError deduplication", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;
  let capturedInnerOnError: ((err: unknown) => string) | undefined;
  let capturedInnerOnFinish:
    | ((args: { messages: unknown[] }) => Promise<void> | void)
    | undefined;
  let executionPromise: Promise<void> | undefined;
  let writerWrites: unknown[];

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      capturedInnerOnError = undefined;
      capturedInnerOnFinish = undefined;
      executionPromise = undefined;
      writerWrites = [];

      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;

      const agent = await makeAgent({
        organizationId,
        name: "Router Agent",
        systemPrompt: "",
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
          onError: (err: unknown) => string;
          onFinish?: (args: { messages: unknown[] }) => Promise<void> | void;
        }) => {
          capturedInnerOnError = opts.onError;
          capturedInnerOnFinish = opts.onFinish;
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
        textStream: {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: true, value: undefined }),
          }),
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
          const writer = {
            write: vi.fn((data: unknown) => writerWrites.push(data)),
            merge: vi.fn(),
          };
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
          request as typeof request & {
            organizationId: string;
          }
        ).organizationId = organizationId;
      });

      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("double onError yields deterministic payload and fires side effects once", async ({
    expect,
  }) => {
    const { default: ConversationChatErrorModel } = await import(
      "@/models/conversation-chat-error"
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await executionPromise;
    expect(capturedInnerOnError).toBeDefined();
    const innerOnError = capturedInnerOnError;
    if (!innerOnError) {
      throw new Error("Expected inner onError to be captured");
    }

    const stage1Error = new Error("Upstream provider error");
    const payload1 = capturedInnerOnError?.(stage1Error);

    const stage2Error = new Error(payload1);
    const payload2 = capturedInnerOnError?.(stage2Error);

    expect(payload2).toBe(payload1);

    await new Promise((resolve) => setImmediate(resolve));

    const errorsAfterDouble =
      await ConversationChatErrorModel.findByConversation(conversationId);
    expect(errorsAfterDouble).toHaveLength(1);

    if (capturedInnerOnFinish) {
      await capturedInnerOnFinish({ messages: [] });
    }
    await new Promise((resolve) => setImmediate(resolve));
    const errorsAfterFinish =
      await ConversationChatErrorModel.findByConversation(conversationId);
    expect(errorsAfterFinish).toHaveLength(1);
  });

  test("formats unavailable tool calls as tool-level errors without persisting chat errors", async ({
    expect,
  }) => {
    const { default: ConversationChatErrorModel } = await import(
      "@/models/conversation-chat-error"
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await executionPromise;
    expect(capturedInnerOnError).toBeDefined();

    const unavailableToolError = new NoSuchToolError({
      toolName: "missing_tool",
      availableTools: ["known_tool"],
    });
    const payload1 = capturedInnerOnError?.(unavailableToolError);
    const payload2 = capturedInnerOnError?.(unavailableToolError);

    expect(payload1).toBe(payload2);
    expect(payload1).toContain(
      "The requested tool is not available in this chat.",
    );
    expect(payload1).toContain('"requestedToolName": "missing_tool"');
    expect(payload1).toContain('"availableToolNames"');
    expect(payload1).toContain("known_tool");
    expect(payload1).toContain("Model tried to call unavailable tool");

    await new Promise((resolve) => setImmediate(resolve));
    const persistedErrors =
      await ConversationChatErrorModel.findByConversation(conversationId);
    expect(persistedErrors).toHaveLength(0);
  });

  test("persists user message with new DB id on provider error and allows subsequent PATCH", async ({
    expect,
  }) => {
    const { default: MessageModel } = await import("@/models/message");

    const clientTempId = "client-temp-msg-1";
    const messageText = "hello from provider-error test";

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: clientTempId,
            role: "user",
            parts: [{ type: "text", text: messageText }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await executionPromise;
    expect(capturedInnerOnError).toBeDefined();

    capturedInnerOnError?.(new Error("Upstream provider error"));
    await new Promise((resolve) => setImmediate(resolve));

    const persisted = await MessageModel.findByConversation(conversationId);
    const userMessage = persisted.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    // The persistence layer assigns a DB id distinct from the client tempId,
    // which is what makes PATCH /api/chat/messages/:id possible later.
    expect(userMessage?.id).not.toBe(clientTempId);

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/api/chat/messages/${userMessage?.id}`,
      payload: { partIndex: 0, text: "Edited after provider error" },
    });
    expect(patchResponse.statusCode).toBe(200);
  });

  test("passes compacted messages to streamText", async () => {
    const compactedMessages = [
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: "Context summary from earlier in this conversation.",
          },
        ],
      },
      {
        id: "recent-user-message",
        role: "user",
        parts: [{ type: "text", text: "continue from here" }],
      },
    ];
    mockCompactMessagesForChat.mockResolvedValue({
      messages: compactedMessages,
      status: "created",
      compaction: {
        id: "compaction-1",
        trigger: "auto",
        originalTokenEstimate: 120_000,
        compactedTokenEstimate: 2_000,
      },
    });
    mockStreamText.mockClear();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await executionPromise;

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(mockStreamText.mock.calls[0]?.[0].messages).toEqual(
      compactedMessages,
    );
  });

  test("strips dangling tool parts when persisting a stopped turn", async () => {
    const { default: MessageModel } = await import("@/models/message");

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-user-1",
            role: "user",
            parts: [{ type: "text", text: "search the web" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await executionPromise;
    expect(capturedInnerOnFinish).toBeDefined();

    // Simulate the AI SDK finalizing a stopped turn: the assistant message
    // carries a tool call that never produced output (interrupted mid-stream).
    await capturedInnerOnFinish?.({
      messages: [
        {
          id: "msg-user-1",
          role: "user",
          parts: [{ type: "text", text: "search the web" }],
        },
        {
          id: "msg-assistant-1",
          role: "assistant",
          parts: [
            { type: "text", text: "Let me search for that." },
            {
              type: "tool-web__search",
              toolCallId: "call_interrupted",
              state: "input-streaming",
              input: { q: "weat" },
            },
          ],
        },
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));

    const persisted = await MessageModel.findByConversation(conversationId);
    const assistantMessage = persisted.find((m) => m.role === "assistant");
    expect(assistantMessage).toBeDefined();

    const parts =
      (assistantMessage?.content as { parts?: Array<Record<string, unknown>> })
        ?.parts ?? [];
    // the dangling tool call is gone, the streamed text is kept
    expect(parts.some((p) => p.toolCallId === "call_interrupted")).toBe(false);
    expect(parts.some((p) => p.type === "text")).toBe(true);
  });

  test("stop endpoint reports stopped:false when no stream is active", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversationId}/stop`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ stopped: false });
  });

  test("emits compaction finish when compaction starts but is not beneficial", async () => {
    mockCompactMessagesForChat.mockImplementation(
      async ({ messages, onCompactionStart }) => {
        onCompactionStart?.();
        return {
          messages,
          status: "skipped",
          compaction: null,
          reason: "not_beneficial",
        };
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await executionPromise;

    expect(writerWrites).toContainEqual({
      type: "data-context-compaction-start",
      data: { trigger: "auto" },
    });
    expect(writerWrites).toContainEqual({
      type: "data-context-compaction-finish",
      data: { status: "skipped", reason: "not_beneficial" },
    });
  });

  test("creates a running active run that replay clients can attach to", async () => {
    const streamedChunk = {
      type: "text-delta",
      id: "text-active-run",
      delta: "still streaming",
    } as const;
    let streamController!: ReadableStreamDefaultController<unknown>;

    mockCreateUIMessageStreamResponse.mockImplementation(
      ({ stream }: { stream: ReadableStream<unknown> }) =>
        new Response(toSseStream(stream), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    mockCreateUIMessageStream.mockImplementationOnce(() => {
      const stream = new ReadableStream<unknown>({
        start(controller) {
          streamController = controller;
        },
      });

      return { tee: () => stream.tee() };
    });

    const postResponsePromise = app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-active-run-user",
            role: "user",
            parts: [{ type: "text", text: "hello active run" }],
          },
        ],
      },
    });

    const activeRun = await waitForRunningActiveRun(conversationId);
    const duplicateResponse = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: "msg-active-run-duplicate-user",
            role: "user",
            parts: [{ type: "text", text: "duplicate active run" }],
          },
        ],
      },
    });
    expect(duplicateResponse.statusCode).toBe(409);
    expect(duplicateResponse.json().error.message).toContain("active response");

    await ActiveChatRunModel.appendEvents({
      runId: activeRun.id,
      seq: 1,
      payloads: [{ type: "start" }, streamedChunk],
    });

    const replayResponsePromise = app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversationId}/active-run`,
    });

    await expect(
      Promise.race([
        replayResponsePromise.then(() => "closed"),
        delay(50).then(() => "still-open"),
      ]),
    ).resolves.toBe("still-open");

    await ActiveChatRunModel.markTerminal({
      runId: activeRun.id,
      status: "completed",
    });
    streamController.close();

    const [postResponse, replayResponse] = await Promise.all([
      postResponsePromise,
      replayResponsePromise,
    ]);

    expect(postResponse.statusCode).toBe(200);
    expect(replayResponse.statusCode).toBe(200);
    expect(readSsePayloads(replayResponse.body)).toContainEqual(streamedChunk);
    const persistedMessages =
      await MessageModel.findByConversation(conversationId);
    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0]?.role).toBe("user");
    expect(persistedMessages[0]?.content).toMatchObject({
      parts: [{ text: "hello active run" }],
    });
    await expect(
      ActiveChatRunModel.findById(activeRun.id),
    ).resolves.toMatchObject({ status: "completed" });
  });
});

async function waitForRunningActiveRun(conversationId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run =
      await ActiveChatRunModel.findRunningByConversation(conversationId);
    if (run) {
      return run;
    }
    await delay(10);
  }

  throw new Error("Active run was not created");
}

function readSsePayloads(body: string): unknown[] {
  return body
    .split("\n\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("data: "))
    .map((entry) => entry.slice("data: ".length))
    .filter((entry) => entry !== "[DONE]")
    .map((entry) => JSON.parse(entry));
}

function toSseStream(stream: ReadableStream<unknown>): ReadableStream<string> {
  return stream.pipeThrough(
    new TransformStream<unknown, string>({
      transform(chunk, controller) {
        controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
      },
      flush(controller) {
        controller.enqueue("data: [DONE]\n\n");
      },
    }),
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
