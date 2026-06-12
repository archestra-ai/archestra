import {
  ADMIN_ROLE_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { NoSuchToolError } from "ai";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { MessageModel, SkillModel } from "@/models";
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
  let agentId: string;
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
      agentId = agent.id;
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
        // the route probes fullStream for the first renderable event before
        // merging; yield one so the probe proceeds to the merge these tests
        // capture (errors are then injected via capturedInnerOnError).
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
    archestraMcpBranding.syncFromOrganization(null);
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
    // the SDK emits a duplicate tool-error part for the same invalid call and
    // stringifies its error in runToolsTransformation, so the second onError
    // invocation receives the raw message string — no NoSuchToolError identity
    const payload2 = capturedInnerOnError?.(unavailableToolError.message);
    // stream-level error chunks can also re-fire onError with the previous
    // return value wrapped in `new Error(errorText)` — replay, don't reprocess
    const payload3 = capturedInnerOnError?.(new Error(payload1));

    expect(payload2).toBe(payload1);
    expect(payload3).toBe(payload1);
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

  test("recovers when only the stringified unavailable-tool message reaches onError", async ({
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

    // regression: this exact shape used to fall through to mapProviderError,
    // marking the run failed and persisting a fatal chat error
    const payload = capturedInnerOnError?.(
      "Model tried to call unavailable tool 'missing_tool'. Available tools: known_tool.",
    );

    expect(payload).toContain(
      "The requested tool is not available in this chat.",
    );
    expect(payload).toContain('"requestedToolName": "missing_tool"');
    expect(payload).toContain("known_tool");

    await new Promise((resolve) => setImmediate(resolve));
    const persistedErrors =
      await ConversationChatErrorModel.findByConversation(conversationId);
    expect(persistedErrors).toHaveLength(0);
  });

  test("formats each distinct unavailable tool error independently within one stream", async ({
    expect,
  }) => {
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

    const firstToolError = new NoSuchToolError({
      toolName: "first_missing_tool",
      availableTools: ["known_tool"],
    });
    const secondToolError = new NoSuchToolError({
      toolName: "second_missing_tool",
      availableTools: ["known_tool"],
    });

    const firstPayload = capturedInnerOnError?.(firstToolError);
    const secondPayload = capturedInnerOnError?.(secondToolError);

    expect(firstPayload).toContain('"requestedToolName": "first_missing_tool"');
    expect(secondPayload).toContain(
      '"requestedToolName": "second_missing_tool"',
    );
    expect(secondPayload).not.toBe(firstPayload);

    // each payload is replayed (not reprocessed) on the downstream
    // re-invocation the AI SDK fires as `new Error(errorText)`.
    expect(capturedInnerOnError?.(new Error(firstPayload))).toBe(firstPayload);
    expect(capturedInnerOnError?.(new Error(secondPayload))).toBe(
      secondPayload,
    );
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
    // applyPromptCacheBreakpoints marks the first and last message (the stable
    // prefix + rolling tail) with Anthropic cache_control before streamText, so
    // the compacted messages reach the model carrying that breakpoint. The
    // default chat model is a Claude 4.5+ model, which uses the 1h cache TTL.
    const cacheBreakpoint = {
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      },
    };
    expect(mockStreamText.mock.calls[0]?.[0].messages).toEqual([
      { ...compactedMessages[0], ...cacheBreakpoint },
      { ...compactedMessages[1], ...cacheBreakpoint },
    ]);
  });

  test("prepends load-tools guidance when the agent loads tools when needed", async () => {
    const { AgentModel } = await import("@/models");
    await AgentModel.update(agentId, {
      toolExposureMode: "search_and_run_only",
      systemPrompt: "You are a careful analyst.",
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

    const systemPrompt = mockStreamText.mock.calls[0]?.[0].system;
    expect(systemPrompt).toContain(
      "Some available tools are not listed upfront",
    );
    expect(systemPrompt).toContain(
      `call \`${archestraMcpBranding.getToolName(TOOL_SEARCH_TOOLS_SHORT_NAME)}\` to find relevant tools`,
    );
    expect(systemPrompt).toContain(
      `then call \`${archestraMcpBranding.getToolName(TOOL_RUN_TOOL_SHORT_NAME)}\``,
    );
    expect(systemPrompt).toContain("You are a careful analyst.");
    expect(systemPrompt?.indexOf("Some available tools")).toBeLessThan(
      systemPrompt?.indexOf("You are a careful analyst.") ?? -1,
    );
  });

  test("adds load-tools guidance when the agent has no authored prompt", async () => {
    const { AgentModel } = await import("@/models");
    await AgentModel.update(agentId, {
      toolExposureMode: "search_and_run_only",
      systemPrompt: null,
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

    const systemPrompt = mockStreamText.mock.calls[0]?.[0].system;
    expect(systemPrompt).toContain(
      "Some available tools are not listed upfront",
    );
    expect(systemPrompt).toContain(
      `call \`${archestraMcpBranding.getToolName(TOOL_SEARCH_TOOLS_SHORT_NAME)}\` to find relevant tools`,
    );
    expect(systemPrompt).toContain(
      `then call \`${archestraMcpBranding.getToolName(TOOL_RUN_TOOL_SHORT_NAME)}\``,
    );
  });

  test("uses branded full tool names in load-tools guidance", async () => {
    archestraMcpBranding.syncFromOrganization({
      appName: "Custom Ops",
      iconLogo: null,
    });
    const { AgentModel } = await import("@/models");
    await AgentModel.update(agentId, {
      toolExposureMode: "search_and_run_only",
      systemPrompt: null,
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

    const systemPrompt = mockStreamText.mock.calls[0]?.[0].system;
    expect(systemPrompt).toContain(
      "call `custom_ops__search_tools` to find relevant tools",
    );
    expect(systemPrompt).toContain("then call `custom_ops__run_tool`");
    expect(systemPrompt).not.toContain("call `search_tools`");
    expect(systemPrompt).not.toContain("then call `run_tool`");
  });

  test("does not add load-tools guidance for fully exposed tools", async () => {
    const { AgentModel } = await import("@/models");
    await AgentModel.update(agentId, {
      toolExposureMode: "full",
      systemPrompt: "Use the normal tools.",
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

    const systemPrompt = mockStreamText.mock.calls[0]?.[0].system;
    expect(systemPrompt).toContain("Use the normal tools.");
    expect(systemPrompt).not.toContain(
      "Some available tools are not listed upfront",
    );
  });

  test("lists the agent's skills in the system prompt when it can activate them", async ({
    makeMember,
  }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "pdf-processing",
        description: "Extract text from PDF files.",
        content: "# PDF Processing\nUse pdftotext.",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    const { AgentModel } = await import("@/models");
    await AgentModel.update(agentId, { systemPrompt: "You are helpful." });
    mockGetChatMcpTools.mockResolvedValue({
      [archestraMcpBranding.getToolName(TOOL_LOAD_SKILL_SHORT_NAME)]: {
        description: "Load a skill",
        inputSchema: { jsonSchema: { type: "object", properties: {} } },
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

    const systemPrompt = mockStreamText.mock.calls[0]?.[0].system;
    expect(systemPrompt).toContain("<available_skills>");
    expect(systemPrompt).toContain("pdf-processing");
    expect(systemPrompt).toContain("You are helpful.");
  });

  test("omits the skill catalog when the agent has no skill tools", async ({
    makeMember,
  }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "pdf-processing",
        description: "Extract text from PDF files.",
        content: "# PDF Processing",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    // beforeEach resets getChatMcpTools to {}, so no load_skill is exposed
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

    const systemPrompt = mockStreamText.mock.calls[0]?.[0].system;
    expect(systemPrompt ?? "").not.toContain("<available_skills>");
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

// streamText result whose fullStream yields the given events. Used to drive the
// route's empty-response probe/retry loop without a live provider.
function fakeStreamResult(events: Array<Record<string, unknown>>) {
  return {
    fullStream: {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async () =>
            index < events.length
              ? { done: false, value: events[index++] }
              : { done: true, value: undefined },
        };
      },
    },
    toUIMessageStream: () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    usage: Promise.resolve(null),
  };
}

// streamText result whose fullStream throws a context-length error on first read,
// matching parseMaxInputTokens. Used to exercise the bounded context-trim retry.
function fakeContextLengthErrorResult() {
  return {
    fullStream: {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("maximum input length of 100 tokens");
        },
      }),
    },
    toUIMessageStream: () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    usage: Promise.resolve(null),
  };
}

const EMPTY_STREAM_EVENTS = [
  { type: "start" },
  { type: "finish", finishReason: "stop" },
];
// Gemini MALFORMED_FUNCTION_CALL shape: a clean finish with unified "error",
// the raw provider reason, and no content or error parts.
const MALFORMED_FUNCTION_CALL_STREAM_EVENTS = [
  { type: "start" },
  {
    type: "finish",
    finishReason: "error",
    rawFinishReason: "MALFORMED_FUNCTION_CALL",
  },
];
const RENDERABLE_STREAM_EVENTS = [
  { type: "text-delta", text: "hi" },
  { type: "finish", finishReason: "stop" },
];

describe("POST /api/chat empty-response retry", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;
  let executionPromise: Promise<void> | undefined;
  let capturedOuterErrorPayload: string | undefined;

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      executionPromise = undefined;
      capturedOuterErrorPayload = undefined;

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
        ({
          execute,
          onError,
        }: {
          execute: (args: {
            writer: {
              write: (x: unknown) => void;
              merge: (s: unknown) => void;
            };
          }) => Promise<void>;
          onError: (error: unknown) => string;
        }) => {
          const writer = { write: vi.fn(), merge: vi.fn() };
          // route the pre-merge throw (exhausted empty response) to onError,
          // mirroring how createUIMessageStream surfaces an execute() rejection.
          executionPromise = execute({ writer }).catch((error) => {
            capturedOuterErrorPayload = onError(error);
          });
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
    await app.close();
  });

  async function postMessage() {
    return app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          { id: "msg-1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ],
      },
    });
  }

  test("retries a clean-but-empty response, then streams the renderable one", async ({
    expect,
  }) => {
    mockStreamText
      .mockImplementationOnce(() => fakeStreamResult(EMPTY_STREAM_EVENTS))
      .mockImplementationOnce(() => fakeStreamResult(RENDERABLE_STREAM_EVENTS));

    const response = await postMessage();
    expect(response.statusCode).toBe(200);
    await executionPromise;

    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(capturedOuterErrorPayload).toBeUndefined();
  });

  test("retries an empty error finish (malformed tool call), then streams the renderable one", async ({
    expect,
  }) => {
    mockStreamText
      .mockImplementationOnce(() =>
        fakeStreamResult(MALFORMED_FUNCTION_CALL_STREAM_EVENTS),
      )
      .mockImplementationOnce(() => fakeStreamResult(RENDERABLE_STREAM_EVENTS));

    const response = await postMessage();
    expect(response.statusCode).toBe(200);
    await executionPromise;

    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(capturedOuterErrorPayload).toBeUndefined();
  });

  test("surfaces an EmptyResponse stream error after exhausting retries on error finishes", async ({
    expect,
  }) => {
    mockStreamText.mockImplementation(() =>
      fakeStreamResult(MALFORMED_FUNCTION_CALL_STREAM_EVENTS),
    );

    const response = await postMessage();
    expect(response.statusCode).toBe(200);
    await executionPromise;

    expect(mockStreamText).toHaveBeenCalledTimes(3);
    expect(capturedOuterErrorPayload).toBeDefined();
    const payload = JSON.parse(capturedOuterErrorPayload ?? "{}");
    expect(payload.code).toBe("empty_response");
  });

  test("surfaces an EmptyResponse stream error after exhausting retries", async ({
    expect,
  }) => {
    mockStreamText.mockImplementation(() =>
      fakeStreamResult(EMPTY_STREAM_EVENTS),
    );

    const response = await postMessage();
    expect(response.statusCode).toBe(200);
    await executionPromise;

    expect(mockStreamText).toHaveBeenCalledTimes(3);
    expect(capturedOuterErrorPayload).toBeDefined();
    const payload = JSON.parse(capturedOuterErrorPayload ?? "{}");
    expect(payload.code).toBe("empty_response");
  });

  test("reuses the trimmed payload when a trimmed attempt then returns empty", async ({
    expect,
  }) => {
    // messages large enough that trimMessagesToTokenLimit (400-char budget for the
    // mocked 100-token limit) actually drops content, so the trimmed payload is
    // observably different from the original.
    const longContent = "x".repeat(300);
    mockCompactMessagesForChat.mockImplementation(async () => ({
      messages: [
        { role: "user", content: longContent },
        { role: "assistant", content: longContent },
        { role: "user", content: longContent },
      ],
      status: "skipped",
      compaction: null,
      reason: "below_threshold",
    }));
    mockStreamText
      .mockImplementationOnce(() => fakeContextLengthErrorResult())
      .mockImplementationOnce(() => fakeStreamResult(EMPTY_STREAM_EVENTS))
      .mockImplementationOnce(() => fakeStreamResult(RENDERABLE_STREAM_EVENTS));

    const response = await postMessage();
    expect(response.statusCode).toBe(200);
    await executionPromise;

    expect(mockStreamText).toHaveBeenCalledTimes(3);
    const originalMessages = mockStreamText.mock.calls[0][0].messages;
    const trimmedMessages = mockStreamText.mock.calls[1][0].messages;
    const emptyRetryMessages = mockStreamText.mock.calls[2][0].messages;
    // the trim must have actually changed the payload, otherwise this test proves
    // nothing about which payload the empty-retry resends.
    expect(trimmedMessages).not.toEqual(originalMessages);
    // the empty-response retry resends the trimmed payload, not the original.
    expect(emptyRetryMessages).toEqual(trimmedMessages);
  });

  test("bounds context-trim retries instead of looping on a repeated context-length error", async ({
    expect,
  }) => {
    // content-shaped model messages so trimMessagesToTokenLimit runs cleanly and
    // the cap (not a crash) is what bounds the loop.
    mockCompactMessagesForChat.mockImplementation(async () => ({
      messages: [{ role: "user", content: "hi" }],
      status: "skipped",
      compaction: null,
      reason: "below_threshold",
    }));
    // every attempt rejects with the same max-token error; trimming is
    // deterministic, so without a cap this would retry forever.
    mockStreamText.mockImplementation(() => fakeContextLengthErrorResult());

    const response = await postMessage();
    expect(response.statusCode).toBe(200);
    await executionPromise;

    // initial attempt + exactly one trim retry, then fall through to the merge.
    expect(mockStreamText).toHaveBeenCalledTimes(2);
  });
});
