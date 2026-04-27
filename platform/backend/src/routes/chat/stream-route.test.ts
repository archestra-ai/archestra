import { vi } from "vitest";
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
        selectedModel: "gpt-4o",
      });
      conversationId = conversation.id;

      mockCreateLLMModelForAgent.mockResolvedValue({ model: "mock-model" });
      mockGetChatMcpTools.mockResolvedValue({});
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
      mockExtractAndIngestDocuments.mockResolvedValue(undefined);
      mockStartActiveChatSpan.mockImplementation(
        async ({ callback }: { callback: () => Promise<Response> }) =>
          callback(),
      );
      mockCreateUIMessageStream.mockImplementation(
        ({ onError }: { onError: (error: Error) => string }) =>
          onError(new Error("Failed to fetch")),
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

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      capturedInnerOnError = undefined;
      capturedInnerOnFinish = undefined;
      executionPromise = undefined;

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
        selectedModel: "gpt-4o",
      });
      conversationId = conversation.id;

      mockCreateLLMModelForAgent.mockResolvedValue({ model: "mock-model" });
      mockGetChatMcpTools.mockResolvedValue({});
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
      mockExtractAndIngestDocuments.mockResolvedValue(undefined);
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
            write: vi.fn(),
            merge: vi.fn(),
          };
          executionPromise = execute({ writer }).catch(() => undefined);
          return "mock-stream";
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

    const stage1Error = new Error("Upstream provider error");
    const payload1 = capturedInnerOnError!(stage1Error);

    const stage2Error = new Error(payload1);
    const payload2 = capturedInnerOnError!(stage2Error);

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
});
