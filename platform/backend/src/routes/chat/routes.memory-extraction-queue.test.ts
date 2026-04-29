import { vi } from "vitest";
import OrganizationModel from "@/models/organization";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  mockCreateLLMModelForAgent,
  mockCreateUIMessageStream,
  mockCreateUIMessageStreamResponse,
  mockExtractAndIngestDocuments,
  mockGetChatMcpTools,
  mockGetChatMcpToolUiResourceUris,
  mockStartActiveChatSpan,
  mockStreamText,
  mockTaskQueueEnqueue,
} = vi.hoisted(() => ({
  mockCreateLLMModelForAgent: vi.fn(),
  mockCreateUIMessageStream: vi.fn(),
  mockCreateUIMessageStreamResponse: vi.fn(),
  mockExtractAndIngestDocuments: vi.fn(),
  mockGetChatMcpTools: vi.fn(),
  mockGetChatMcpToolUiResourceUris: vi.fn(),
  mockStartActiveChatSpan: vi.fn(),
  mockStreamText: vi.fn(),
  mockTaskQueueEnqueue: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    convertToModelMessages: vi.fn(async (messages) => messages),
    createUIMessageStream: mockCreateUIMessageStream,
    createUIMessageStreamResponse: mockCreateUIMessageStreamResponse,
    streamText: mockStreamText,
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

vi.mock("@/task-queue", () => ({
  taskQueueService: {
    enqueue: mockTaskQueueEnqueue,
  },
}));

describe("chat routes memory extraction queue scheduling", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;
  let agentId: string;

  beforeEach(
    async ({
      makeAgent,
      makeConversation,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      vi.clearAllMocks();
      mockCreateLLMModelForAgent.mockResolvedValue({ model: "mock-model" });
      mockGetChatMcpTools.mockResolvedValue({});
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
      mockExtractAndIngestDocuments.mockResolvedValue(undefined);
      mockStartActiveChatSpan.mockImplementation(
        async ({ callback }: { callback: () => Promise<Response> }) =>
          await callback(),
      );
      mockTaskQueueEnqueue.mockResolvedValue(crypto.randomUUID());

      mockStreamText.mockImplementation(() => ({
        textStream: {
          async *[Symbol.asyncIterator]() {
            yield "ok";
          },
        },
        toUIMessageStream: ({
          originalMessages,
          onFinish,
        }: {
          originalMessages: unknown[];
          onFinish: (payload: { messages: unknown[] }) => Promise<void> | void;
        }) => {
          void onFinish({ messages: originalMessages });
          return "mock-ui-stream";
        },
        usage: Promise.resolve(null),
      }));

      mockCreateUIMessageStream.mockImplementation(
        ({
          execute,
        }: {
          execute: (args: { writer: unknown }) => Promise<void>;
        }) => {
          const writer = {
            write: vi.fn(),
            merge: vi.fn(),
          };
          void execute({ writer });
          return "mock-created-stream";
        },
      );
      mockCreateUIMessageStreamResponse.mockImplementation(
        ({ stream }: { stream: unknown }) =>
          new Response(String(stream), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      );

      user = await makeUser();
      const organization = await makeOrganization({ name: "Queue Delay Org" });
      organizationId = organization.id;
      await makeMember(user.id, organizationId, { role: "admin" });
      await OrganizationModel.patch(organizationId, {
        memoryIdleDelaySeconds: 90,
      });

      const agent = await makeAgent({
        organizationId,
        name: "Queue Test Agent",
        systemPrompt: "",
      });
      agentId = agent.id;
      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId,
        selectedModel: "gpt-4o",
        selectedProvider: "openai",
      });
      conversationId = conversation.id;

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

  test("schedules memory extraction based on organization idle delay", async () => {
    const before = Date.now();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "Remember my preference." }],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockTaskQueueEnqueue).toHaveBeenCalledTimes(1);
    });

    const [enqueuePayload] = mockTaskQueueEnqueue.mock.calls[0] as [
      {
        taskType: string;
        payload: {
          conversationId: string;
          userId: string;
          organizationId: string;
          agentId: string;
        };
        scheduledFor?: Date;
      },
    ];

    expect(enqueuePayload.taskType).toBe("memory_extract_candidates");
    expect(enqueuePayload.payload).toEqual({
      conversationId,
      userId: user.id,
      organizationId,
      agentId,
    });
    expect(enqueuePayload.scheduledFor).toBeInstanceOf(Date);

    const scheduledAt = enqueuePayload.scheduledFor?.getTime();
    expect(scheduledAt).toBeDefined();
    const deltaMs = (scheduledAt as number) - before;
    expect(deltaMs).toBeGreaterThanOrEqual(88_000);
    expect(deltaMs).toBeLessThanOrEqual(110_000);
  });
});
