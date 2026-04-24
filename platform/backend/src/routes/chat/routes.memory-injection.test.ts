import { vi } from "vitest";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  memoryInjectionFlag,
  mockCreateLLMModelForAgent,
  mockCreateUIMessageStream,
  mockCreateUIMessageStreamResponse,
  mockExtractAndIngestDocuments,
  mockGetChatMcpTools,
  mockGetChatMcpToolUiResourceUris,
  mockLoggerInfo,
  mockMemoryInjectionBuild,
  mockRenderSystemPrompt,
  mockReportMemoryScopeViolationBlocked,
  mockStartActiveChatSpan,
} = vi.hoisted(() => ({
  memoryInjectionFlag: { enabled: true },
  mockCreateLLMModelForAgent: vi.fn(),
  mockCreateUIMessageStream: vi.fn(),
  mockCreateUIMessageStreamResponse: vi.fn(),
  mockExtractAndIngestDocuments: vi.fn(),
  mockGetChatMcpTools: vi.fn(),
  mockGetChatMcpToolUiResourceUris: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockMemoryInjectionBuild: vi.fn(),
  mockRenderSystemPrompt: vi.fn(),
  mockReportMemoryScopeViolationBlocked: vi.fn(),
  mockStartActiveChatSpan: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    convertToModelMessages: vi.fn(async (messages) => messages),
    createUIMessageStream: mockCreateUIMessageStream,
    createUIMessageStreamResponse: mockCreateUIMessageStreamResponse,
    streamText: vi.fn(),
  };
});

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    ...actual,
    default: new Proxy(actual.default, {
      get(target, prop, receiver) {
        if (prop === "memory") {
          return {
            ...target.memory,
            injectionEnabled: memoryInjectionFlag.enabled,
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
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

vi.mock("@/memory/injection/injection-builder", () => ({
  memoryInjectionBuilder: {
    build: mockMemoryInjectionBuild,
  },
}));

vi.mock("@/memory/telemetry/metrics", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/memory/telemetry/metrics")>();
  return {
    ...actual,
    reportMemoryScopeViolationBlocked: mockReportMemoryScopeViolationBlocked,
  };
});

vi.mock("@/templating", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/templating")>();
  return {
    ...actual,
    renderSystemPrompt: mockRenderSystemPrompt,
  };
});

vi.mock("@/logging", () => ({
  default: (() => {
    const logger = {
      info: mockLoggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockImplementation(() => logger);
    return logger;
  })(),
}));

describe("chat routes memory injection wiring", () => {
  test("injects durable memory block when feature flag is on and context is trusted", async ({
    makeAgent,
    makeConversation,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    memoryInjectionFlag.enabled = true;
    const appContext = await createAppContext({
      considerContextUntrusted: false,
      mcpTools: {},
      makeAgent: adaptFactory(makeAgent),
      makeConversation: adaptFactory(makeConversation),
      makeMember: adaptFactory(makeMember),
      makeOrganization: adaptFactory(makeOrganization),
      makeUser: adaptFactory(makeUser),
    });

    try {
      mockMemoryInjectionBuild.mockResolvedValue(
        "<durable_memory>\n- [preference] concise responses\n</durable_memory>",
      );

      const response = await appContext.app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          id: appContext.conversationId,
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "Hello" }],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockMemoryInjectionBuild).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      );

      const [promptTemplate, promptContext] = mockRenderSystemPrompt.mock
        .calls[0] as [string, { memory?: string | null } | null];
      expect(promptTemplate).toContain("{{#if memory}}");
      expect(promptContext?.memory).toContain("<durable_memory>");
      expect(mockReportMemoryScopeViolationBlocked).not.toHaveBeenCalled();
    } finally {
      await appContext.app.close();
    }
  });

  test("omits memory block and emits violation telemetry/log for untrusted context", async ({
    makeAgent,
    makeConversation,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    memoryInjectionFlag.enabled = true;
    const appContext = await createAppContext({
      considerContextUntrusted: true,
      mcpTools: {},
      makeAgent: adaptFactory(makeAgent),
      makeConversation: adaptFactory(makeConversation),
      makeMember: adaptFactory(makeMember),
      makeOrganization: adaptFactory(makeOrganization),
      makeUser: adaptFactory(makeUser),
    });

    try {
      mockMemoryInjectionBuild.mockResolvedValue(null);

      const response = await appContext.app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          id: appContext.conversationId,
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "Hello" }],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockMemoryInjectionBuild).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );

      const [promptTemplate, promptContext] = mockRenderSystemPrompt.mock
        .calls[0] as [string, { memory?: string | null } | null];
      expect(promptTemplate).not.toContain("{{#if memory}}");
      expect(promptContext?.memory ?? null).toBeNull();
      expect(mockReportMemoryScopeViolationBlocked).toHaveBeenCalledWith({
        scopeType: "user",
        reason: "untrusted_context",
      });
      expect(
        mockLoggerInfo.mock.calls.some(
          ([payload, message]) =>
            message === "[memory] injection: memory_injection_blocked" &&
            (payload as { reason?: string }).reason === "untrusted_context",
        ),
      ).toBe(true);
    } finally {
      await appContext.app.close();
    }
  });

  test("omits memory block without violation telemetry when feature flag is off", async ({
    makeAgent,
    makeConversation,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    memoryInjectionFlag.enabled = false;
    const appContext = await createAppContext({
      considerContextUntrusted: false,
      mcpTools: {},
      makeAgent: adaptFactory(makeAgent),
      makeConversation: adaptFactory(makeConversation),
      makeMember: adaptFactory(makeMember),
      makeOrganization: adaptFactory(makeOrganization),
      makeUser: adaptFactory(makeUser),
    });

    try {
      mockMemoryInjectionBuild.mockResolvedValue(null);

      const response = await appContext.app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          id: appContext.conversationId,
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "Hello" }],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockMemoryInjectionBuild).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );

      const [promptTemplate, promptContext] = mockRenderSystemPrompt.mock
        .calls[0] as [string, { memory?: string | null } | null];
      expect(promptTemplate).not.toContain("{{#if memory}}");
      expect(promptContext?.memory ?? null).toBeNull();
      expect(mockReportMemoryScopeViolationBlocked).not.toHaveBeenCalled();
    } finally {
      await appContext.app.close();
    }
  });

  test("omits memory block when trusted-context agent has external tools", async ({
    makeAgent,
    makeConversation,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    memoryInjectionFlag.enabled = true;
    const appContext = await createAppContext({
      considerContextUntrusted: false,
      mcpTools: {
        playwright__browser_navigate: {
          description: "Mock external browser tool",
          execute: vi.fn(),
        },
      },
      makeAgent: adaptFactory(makeAgent),
      makeConversation: adaptFactory(makeConversation),
      makeMember: adaptFactory(makeMember),
      makeOrganization: adaptFactory(makeOrganization),
      makeUser: adaptFactory(makeUser),
    });

    try {
      mockMemoryInjectionBuild.mockResolvedValue(null);

      const response = await appContext.app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          id: appContext.conversationId,
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "Hello" }],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockMemoryInjectionBuild).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
      expect(mockReportMemoryScopeViolationBlocked).toHaveBeenCalledWith({
        scopeType: "user",
        reason: "external_tools_with_trusted_context",
      });
    } finally {
      await appContext.app.close();
    }
  });
});

async function createAppContext(params: {
  considerContextUntrusted: boolean;
  mcpTools?: Record<string, unknown>;
  makeAgent: (...args: unknown[]) => Promise<{ id: string }>;
  makeConversation: (...args: unknown[]) => Promise<{ id: string }>;
  makeMember: (...args: unknown[]) => Promise<unknown>;
  makeOrganization: (...args: unknown[]) => Promise<{ id: string }>;
  makeUser: (...args: unknown[]) => Promise<User>;
}) {
  vi.clearAllMocks();
  mockRenderSystemPrompt.mockImplementation((template: string) => template);

  mockCreateLLMModelForAgent.mockResolvedValue({ model: "mock-model" });
  mockGetChatMcpTools.mockResolvedValue(params.mcpTools ?? {});
  mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
  mockExtractAndIngestDocuments.mockResolvedValue(undefined);
  mockStartActiveChatSpan.mockImplementation(
    async ({ callback }: { callback: () => Promise<Response> }) =>
      await callback(),
  );
  mockCreateUIMessageStream.mockImplementation(() => "mock-created-stream");
  mockCreateUIMessageStreamResponse.mockImplementation(
    ({ stream }: { stream: unknown }) =>
      new Response(String(stream), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  );

  const user = await params.makeUser();
  const organization = await params.makeOrganization();
  await params.makeMember(user.id, organization.id, { role: "admin" });

  const agent = await params.makeAgent({
    organizationId: organization.id,
    name: "Memory Injection Test Agent",
    systemPrompt: "You are a helpful assistant.",
    considerContextUntrusted: params.considerContextUntrusted,
  });
  const conversation = await params.makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
  });

  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    (request as typeof request & { user: User }).user = user;
    (
      request as typeof request & {
        organizationId: string;
      }
    ).organizationId = organization.id;
  });

  const { default: chatRoutes } = await import("./routes");
  await app.register(chatRoutes);

  return {
    app: app as FastifyInstanceWithZod,
    conversationId: conversation.id,
  };
}

function adaptFactory<TArgs extends unknown[], TResult>(
  factory: (...args: TArgs) => Promise<TResult>,
): (...args: unknown[]) => Promise<TResult> {
  return async (...args: unknown[]) => await factory(...(args as TArgs));
}
