import {
  type ChatMessagePart,
  TOOL_RUN_COMMAND_SHORT_NAME,
} from "@archestra/shared";
import { convertToModelMessages, type UIMessage } from "ai";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import config from "@/config";
import { MessageModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { activeChatRunService } from "@/services/active-chat-run";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ChatMessage, User } from "@/types";
import { normalizeChatMessages } from "./normalization/normalize-chat-messages";
import { runSandboxCommandTurn } from "./sandbox-command-turn";

const mockCreateLLMModelForAgent = vi.hoisted(() => vi.fn());
const mockGetChatMcpTools = vi.hoisted(() => vi.fn());
const mockGetChatMcpToolUiResourceUris = vi.hoisted(() => vi.fn());
const mockExtractAndIngestDocuments = vi.hoisted(() => vi.fn());
const mockStartActiveChatSpan = vi.hoisted(() => vi.fn());
const mockRunSandboxCommand = vi.hoisted(() => vi.fn());

// The Dagger engine is the process boundary: without this mock an enabled
// sandbox genuinely tries to reach an engine and hangs the suite. Everything
// above it (tool dispatch, RBAC, replay-log persistence) stays real.
vi.mock("@/sandbox-runtime/sandbox-runtime-service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/sandbox-runtime/sandbox-runtime-service")
    >();
  return {
    ...actual,
    sandboxRuntimeService: {
      isEnabled: true,
      isReady: true,
      bootStatus: "ready",
      runCommand: mockRunSandboxCommand,
    },
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

const runCommandToolName = () =>
  archestraMcpBranding.getToolName(TOOL_RUN_COMMAND_SHORT_NAME);

const toolPartsOf = (message: ChatMessage): ChatMessagePart[] =>
  (message.parts ?? []).filter(
    (part) => part.type === `tool-${runCommandToolName()}`,
  );

describe("POST /api/chat sandbox command turn", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let agentId: string;
  let conversationId: string;

  beforeEach(
    async ({
      makeAgent,
      makeConversation,
      makeCustomRole,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    }) => {
      // Must be on BEFORE seeding: the sandbox tools are only seeded (and thus
      // assignable) while the feature is enabled. The per-test config restore
      // runs before this hook, so the flag holds for the whole test; the
      // fail-closed test flips it off explicitly.
      config.skillsSandbox.enabled = true;

      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;

      const role = await makeCustomRole(organizationId, {
        permission: { sandbox: ["execute"], chat: ["read", "create"] },
      });
      await makeMember(user.id, organizationId, { role: role.role });

      const agent = await makeAgent({
        organizationId,
        name: "Sandbox Agent",
        systemPrompt: "",
      });
      agentId = agent.id;
      await seedAndAssignArchestraTools(agentId);

      const conversation = await makeConversation(agentId, {
        userId: user.id,
        organizationId,
      });
      conversationId = conversation.id;

      mockCreateLLMModelForAgent.mockResolvedValue({ model: "mock-model" });
      mockGetChatMcpTools.mockResolvedValue({});
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
      mockExtractAndIngestDocuments.mockResolvedValue(undefined);
      mockRunSandboxCommand.mockResolvedValue({
        stdout: "hi\n",
        stderr: "",
        exitCode: 0,
        durationMs: 12,
        timedOut: false,
        truncated: false,
      });
      mockStartActiveChatSpan.mockImplementation(
        async ({ callback }: { callback: () => Promise<Response> }) =>
          callback(),
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

  const markedUserMessage = (text: string, id = "msg-user-1") => ({
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { sandboxCommand: true },
  });

  const postChat = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/chat", payload });

  test("executes the command without an LLM call and persists the turn as a run_command tool part", async () => {
    const response = await postChat({
      id: conversationId,
      messages: [markedUserMessage("! echo hi")],
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetChatMcpTools).not.toHaveBeenCalled();
    expect(mockCreateLLMModelForAgent).not.toHaveBeenCalled();

    await vi.waitFor(async () => {
      const rows = await MessageModel.findByConversation(conversationId);
      expect(rows).toHaveLength(2);
    });
    const rows = await MessageModel.findByConversation(conversationId);
    const [userRow, assistantRow] = rows.map(
      (row) => row.content as ChatMessage,
    );

    expect(userRow.role).toBe("user");
    expect(
      (userRow.metadata as { sandboxCommand?: boolean }).sandboxCommand,
    ).toBe(true);

    expect(assistantRow.role).toBe("assistant");
    const toolParts = toolPartsOf(assistantRow);
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0].state).toBe("output-available");
    expect(toolParts[0].input).toEqual({ command: "echo hi" });
    expect(typeof toolParts[0].output).toBe("string");
    expect(mockRunSandboxCommand).toHaveBeenCalledTimes(1);
    expect(mockRunSandboxCommand.mock.calls[0][0].command).toBe("echo hi");
  });

  test("a non-zero exit code is normal tool output, not a turn error", async () => {
    mockRunSandboxCommand.mockResolvedValue({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      durationMs: 5,
      timedOut: false,
      truncated: false,
    });

    const response = await postChat({
      id: conversationId,
      messages: [markedUserMessage("! false")],
    });

    expect(response.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const rows = await MessageModel.findByConversation(conversationId);
      expect(rows).toHaveLength(2);
    });
    const assistant = (await MessageModel.findByConversation(conversationId))
      .map((row) => row.content as ChatMessage)
      .at(-1);
    const toolParts = toolPartsOf(assistant as ChatMessage);
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0].state).toBe("output-available");
  });

  test("fails closed when the marker is present but the sandbox is unavailable", async () => {
    config.skillsSandbox.enabled = false;
    const response = await postChat({
      id: conversationId,
      messages: [markedUserMessage("! echo hi")],
    });

    expect(response.statusCode).toBe(403);
    expect(mockGetChatMcpTools).not.toHaveBeenCalled();
    expect(mockRunSandboxCommand).not.toHaveBeenCalled();
    // The user message persists (early persist runs before the availability
    // check), but no command ran and no assistant turn exists.
    const rows = await MessageModel.findByConversation(conversationId);
    expect(rows).toHaveLength(1);
    expect((rows[0].content as ChatMessage).role).toBe("user");

    // The active run was terminalized: a follow-up send is not 409-blocked.
    const retry = await postChat({
      id: conversationId,
      messages: [markedUserMessage("! echo hi")],
    });
    expect(retry.statusCode).toBe(403);
  });

  test("a runtime failure surfaces as tool output through the real error mapping", async () => {
    mockRunSandboxCommand.mockRejectedValue(new Error("engine unreachable"));

    const response = await postChat({
      id: conversationId,
      messages: [markedUserMessage("! echo hi")],
    });

    expect(response.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const rows = await MessageModel.findByConversation(conversationId);
      expect(rows).toHaveLength(2);
    });
    const assistant = (await MessageModel.findByConversation(conversationId))
      .map((row) => row.content as ChatMessage)
      .at(-1);
    // The runtime error travels the same path as a model-initiated failure:
    // an isError tool result persisted as readable tool output, not a crash.
    const toolParts = toolPartsOf(assistant as ChatMessage);
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0].state).toBe("output-available");
    expect(typeof toolParts[0].output).toBe("string");
  });

  test("a marked message with multiple text parts is not executed", async () => {
    const response = await postChat({
      id: conversationId,
      messages: [
        {
          id: "msg-user-1",
          role: "user",
          parts: [
            { type: "text", text: "! echo hi" },
            { type: "text", text: "&& rm -rf /" },
          ],
          metadata: { sandboxCommand: true },
        },
      ],
    });

    // Falls through to the normal LLM path — the composer never produces
    // multi-text-part messages, so this shape is not a command.
    expect(response.statusCode).toBe(200);
    expect(mockRunSandboxCommand).not.toHaveBeenCalled();
    expect(mockGetChatMcpTools).toHaveBeenCalledTimes(1);
  });

  test("a !-prefixed message without the marker goes to the normal LLM path", async () => {
    const response = await postChat({
      id: conversationId,
      messages: [
        {
          id: "msg-user-1",
          role: "user",
          parts: [{ type: "text", text: "! echo hi" }],
        },
      ],
    });

    // The LLM context build ran (the turn itself fails later on the mock
    // model, which is irrelevant here — the point is the branch was not taken).
    expect(response.statusCode).toBe(200);
    expect(mockGetChatMcpTools).toHaveBeenCalledTimes(1);
  });

  test("regenerate re-runs the command and replaces the trailing turn instead of appending", async () => {
    const first = await postChat({
      id: conversationId,
      messages: [markedUserMessage("! echo hi")],
    });
    expect(first.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect(
        await MessageModel.findByConversation(conversationId),
      ).toHaveLength(2);
    });
    const staleAssistantId = (
      (await MessageModel.findByConversation(conversationId))[1]
        .content as ChatMessage
    ).id;

    const regen = await postChat({
      id: conversationId,
      trigger: "regenerate-message",
      messages: [markedUserMessage("! echo hi")],
    });
    expect(regen.statusCode).toBe(200);

    await vi.waitFor(async () => {
      const rows = await MessageModel.findByConversation(conversationId);
      expect(rows).toHaveLength(2);
      const assistant = rows[1].content as ChatMessage;
      expect(assistant.id).not.toBe(staleAssistantId);
      expect(toolPartsOf(assistant)).toHaveLength(1);
    });
  });

  test("a stop requested before execution persists an output-error part and runs nothing", async () => {
    const activeRun = await activeChatRunService.createRun({
      conversationId,
      userId: user.id,
      organizationId,
    });
    expect(activeRun).not.toBeNull();
    if (!activeRun) throw new Error("unreachable");

    const abortController = new AbortController();
    abortController.abort();

    const persisted: ChatMessage[][] = [];
    const headers: Record<string, string> = {};
    const replyStub = {
      header: (key: string, value: string) => {
        headers[key] = value;
      },
      send: (body: ReadableStream<Uint8Array>) => body,
    };

    const body = (await runSandboxCommandTurn({
      command: "echo hi",
      messages: [markedUserMessage("! echo hi") as ChatMessage],
      conversationId,
      agent: { id: agentId, name: "Sandbox Agent" },
      userId: user.id,
      organizationId,
      activeRunId: activeRun.id,
      abortController,
      // biome-ignore lint/suspicious/noExplicitAny: minimal reply stub — only header/send are used by the turn
      reply: replyStub as any,
      persistTurn: async (finalMessages) => {
        persisted.push(finalMessages);
      },
      onStreamSettled: () => {},
      buildErrorPayload: ({ mappedError }) => JSON.stringify(mappedError),
    })) as unknown as ReadableStream<Uint8Array>;

    const reader = body.getReader();
    while (!(await reader.read()).done) {
      // drain the SSE stream so the turn settles
    }

    await vi.waitFor(() => expect(persisted).toHaveLength(1));
    const assistant = persisted[0].at(-1);
    expect(assistant?.role).toBe("assistant");
    const toolParts = toolPartsOf(assistant as ChatMessage);
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0].state).toBe("output-error");
  });

  test("a persistence failure after execution is contained: the stream still completes", async () => {
    const activeRun = await activeChatRunService.createRun({
      conversationId,
      userId: user.id,
      organizationId,
    });
    expect(activeRun).not.toBeNull();
    if (!activeRun) throw new Error("unreachable");

    const replyStub = {
      header: () => {},
      send: (body: ReadableStream<Uint8Array>) => body,
    };

    const body = (await runSandboxCommandTurn({
      command: "echo hi",
      messages: [markedUserMessage("! echo hi") as ChatMessage],
      conversationId,
      agent: { id: agentId, name: "Sandbox Agent" },
      userId: user.id,
      organizationId,
      activeRunId: activeRun.id,
      abortController: new AbortController(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal reply stub — only header/send are used by the turn
      reply: replyStub as any,
      persistTurn: async () => {
        throw new Error("simulated persistence failure");
      },
      onStreamSettled: () => {},
      buildErrorPayload: ({ mappedError }) => JSON.stringify(mappedError),
    })) as unknown as ReadableStream<Uint8Array>;

    // The command ran and the stream drains to completion — the persistence
    // error is logged, not propagated into the response stream.
    const chunks: string[] = [];
    const reader = body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    expect(mockRunSandboxCommand).toHaveBeenCalledTimes(1);
    expect(chunks.join("")).not.toContain('"type":"error"');
  });
});

describe("sandbox command tool part model visibility", () => {
  test("the persisted tool part survives normalization and reaches the model messages", async () => {
    const toolName = runCommandToolName();
    const messages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "! echo hi" }],
        metadata: { sandboxCommand: true },
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: `tool-${toolName}`,
            toolCallId: "call-1",
            state: "output-available",
            input: { command: "echo hi" },
            output: "Exit code 0\nstdout:\nhi",
          },
        ],
      },
    ];

    const normalized = normalizeChatMessages(messages);
    const modelMessages = await convertToModelMessages(
      normalized as unknown as Omit<UIMessage, "id">[],
    );

    const assistantMessage = modelMessages.find((m) => m.role === "assistant");
    expect(assistantMessage).toBeDefined();
    expect(
      (assistantMessage?.content as Array<{ type: string; toolName?: string }>)
        .filter((part) => part.type === "tool-call")
        .map((part) => part.toolName),
    ).toEqual([toolName]);

    const toolMessage = modelMessages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(
      (toolMessage?.content as Array<{ type: string; toolCallId?: string }>)
        .filter((part) => part.type === "tool-result")
        .map((part) => part.toolCallId),
    ).toEqual(["call-1"]);
  });
});
