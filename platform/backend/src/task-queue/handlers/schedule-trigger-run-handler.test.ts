import { beforeEach, describe, expect, test, vi } from "vitest";

const mockRunFindById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockRunMarkCompleted = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockTriggerFindById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockUserGetById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockAgentFindById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockUserHasAgentAccess = vi.hoisted(() =>
  vi.fn().mockResolvedValue(true),
);
const mockHasAnyAgentTypeAdminPermission = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: false }),
);
const mockMessageBulkCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockSetChatConversationId = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockAppendLinkedScheduleRunMessagesToConversation = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockTriggerUpdate = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockIsAgentValidForLinkedConversation = vi.hoisted(() =>
  vi.fn().mockResolvedValue(true),
);

const mockDbTransaction = vi.hoisted(() => vi.fn());
const mockResolveConversationLlmSelectionForAgent = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    chatApiKeyId: null,
  }),
);
const mockTxExecute = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockTxSelect = vi.hoisted(() => vi.fn());
const mockTxInsert = vi.hoisted(() => vi.fn());
const mockTxUpdate = vi.hoisted(() => vi.fn());

vi.mock("@/models", () => ({
  ScheduleTriggerRunModel: {
    findById: mockRunFindById,
    markCompleted: mockRunMarkCompleted,
    setChatConversationId: mockSetChatConversationId,
  },
  ScheduleTriggerModel: {
    findById: mockTriggerFindById,
    update: mockTriggerUpdate,
  },
  UserModel: {
    getById: mockUserGetById,
  },
  AgentModel: {
    findById: mockAgentFindById,
  },
  AgentTeamModel: {
    userHasAgentAccess: mockUserHasAgentAccess,
  },
  MessageModel: {
    bulkCreate: mockMessageBulkCreate,
  },
}));

vi.mock("@/auth", () => ({
  hasAnyAgentTypeAdminPermission: mockHasAnyAgentTypeAdminPermission,
}));

vi.mock("@/utils/llm-resolution", () => ({
  resolveConversationLlmSelectionForAgent:
    mockResolveConversationLlmSelectionForAgent,
}));

vi.mock("@/schedule-triggers/append-linked-run-messages", () => ({
  appendLinkedScheduleRunMessagesToConversation:
    mockAppendLinkedScheduleRunMessagesToConversation,
}));

vi.mock("@/schedule-triggers/converter", () => ({
  scheduleTriggerConverterService: {
    isAgentValidForLinkedConversation: mockIsAgentValidForLinkedConversation,
  },
}));

const mockExecuteA2AMessage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "msg-1", text: "done" }),
);
vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: mockExecuteA2AMessage,
}));

const mockGetReplyChannelDeliveryContext = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    availableChannels: ["chat"],
    slackDmBinding: null,
  }),
);
vi.mock("@/schedule-triggers/reply-channels", () => ({
  getReplyChannelDeliveryContext: mockGetReplyChannelDeliveryContext,
}));

const mockSendReply = vi.hoisted(() => vi.fn().mockResolvedValue("ts-1"));
const mockGetSlackProvider = vi.hoisted(() => vi.fn().mockReturnValue(null));
vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    getSlackProvider: mockGetSlackProvider,
  },
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockNotifyConversationMessagesUpdated = vi.hoisted(() => vi.fn());
const mockNotifyScheduleTriggerRunUpdated = vi.hoisted(() => vi.fn());
vi.mock("@/websocket", () => ({
  default: {
    notifyConversationMessagesUpdated: mockNotifyConversationMessagesUpdated,
    notifyScheduleTriggerRunUpdated: mockNotifyScheduleTriggerRunUpdated,
  },
}));

import db from "@/database";
import logger from "@/logging";
import { handleScheduleTriggerRunExecution } from "./schedule-trigger-run-handler";

const makeRun = (overrides = {}) => ({
  id: "run-1",
  organizationId: "org-1",
  triggerId: "trigger-1",
  runKind: "due" as const,
  status: "running" as const,
  initiatedByUserId: null,
  chatConversationId: null,
  startedAt: new Date(),
  completedAt: null,
  error: null,
  createdAt: new Date(),
  ...overrides,
});

const makeTrigger = (overrides = {}) => ({
  id: "trigger-1",
  organizationId: "org-1",
  name: "Test Trigger",
  agentId: "agent-1",
  messageTemplate: "Run the task",
  cronExpression: "* * * * *",
  timezone: "UTC",
  enabled: true,
  keepResultsInSameChat: false,
  actorUserId: "user-1",
  lastExecutedAt: null,
  createdAt: new Date(),
  ...overrides,
});

const makeUser = () => ({
  id: "user-1",
  name: "Test User",
  email: "test@test.com",
});

const makeAgent = (overrides = {}) => ({
  id: "agent-1",
  organizationId: "org-1",
  agentType: "agent",
  name: "Test Agent",
  ...overrides,
});

describe("handleScheduleTriggerRunExecution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRunFindById.mockResolvedValue(null);
    mockRunMarkCompleted.mockResolvedValue(null);
    mockTriggerFindById.mockResolvedValue(null);
    mockUserGetById.mockResolvedValue(null);
    mockAgentFindById.mockResolvedValue(null);
    mockUserHasAgentAccess.mockResolvedValue(true);
    mockHasAnyAgentTypeAdminPermission.mockResolvedValue({ success: false });
    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "msg-1",
      text: "done",
    });
    mockMessageBulkCreate.mockResolvedValue(undefined);
    mockSetChatConversationId.mockResolvedValue(undefined);
    mockAppendLinkedScheduleRunMessagesToConversation.mockResolvedValue(
      undefined,
    );
    mockTriggerUpdate.mockResolvedValue(undefined);
    mockIsAgentValidForLinkedConversation.mockResolvedValue(true);
    mockNotifyConversationMessagesUpdated.mockClear();
    vi.mocked(logger.error).mockClear();

    mockTxExecute.mockReset().mockResolvedValue(undefined);
    mockTxSelect.mockReset();
    mockTxInsert.mockReset();
    mockTxUpdate.mockReset();
    mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
      chatApiKeyId: null,
    });
    mockGetReplyChannelDeliveryContext.mockResolvedValue({
      availableChannels: ["chat"],
      slackDmBinding: null,
    });
    mockGetSlackProvider.mockReturnValue(null);
    mockSendReply.mockClear();
    mockDbTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        execute: mockTxExecute,
        select: mockTxSelect,
        insert: mockTxInsert,
        update: mockTxUpdate,
      }),
    );
    vi.spyOn(db, "transaction").mockImplementation(
      mockDbTransaction as typeof db.transaction,
    );
  });

  test("executes A2A message and marks run as success", async () => {
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(makeTrigger());
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockUserHasAgentAccess.mockResolvedValue(true);

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        message: "Run the task",
        organizationId: "org-1",
        userId: "user-1",
        sessionId: "scheduled-run-1",
        source: "schedule-trigger",
      }),
    );
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "success",
      error: null,
    });
    expect(mockMessageBulkCreate).not.toHaveBeenCalled();
    expect(mockSetChatConversationId).not.toHaveBeenCalled();
    expect(mockNotifyConversationMessagesUpdated).not.toHaveBeenCalled();
  });

  test("uses linked conversation session and persists messages when configured", async () => {
    const linkedId = "00000000-0000-4000-8000-000000000001";
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(
      makeTrigger({ linkedConversationId: linkedId }),
    );
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockUserHasAgentAccess.mockResolvedValue(true);

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: linkedId,
        conversationId: linkedId,
        agentId: "agent-1",
        userId: "user-1",
        source: "schedule-trigger",
      }),
    );
    expect(
      mockAppendLinkedScheduleRunMessagesToConversation,
    ).toHaveBeenCalledWith({
      conversationId: linkedId,
      messageTemplate: "Run the task",
      assistantText: "done",
    });
    expect(mockSetChatConversationId).toHaveBeenCalledWith("run-1", linkedId);
    expect(mockNotifyConversationMessagesUpdated).toHaveBeenCalledWith({
      conversationId: linkedId,
    });
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "success",
      error: null,
    });
  });

  test("falls back to chat when selected reply channel is unavailable", async () => {
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(
      makeTrigger({ replyChannel: "slack_dm" }),
    );
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockGetReplyChannelDeliveryContext).toHaveBeenCalledWith({
      actorEmail: "test@test.com",
    });
    expect(mockSendReply).not.toHaveBeenCalled();
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "success",
      error: null,
    });
  });

  test("delivers to Slack DM when reply channel is slack_dm and binding exists", async () => {
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(
      makeTrigger({ replyChannel: "slack_dm" }),
    );
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockGetReplyChannelDeliveryContext.mockResolvedValue({
      availableChannels: ["chat", "slack_dm"],
      slackDmBinding: { channelId: "D123", workspaceId: "T1" },
    });
    mockGetSlackProvider.mockReturnValue({ sendReply: mockSendReply });

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockSendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "done",
        originalMessage: expect.objectContaining({
          messageId: "schedule-trigger-run:run-1",
          channelId: "D123",
          workspaceId: "T1",
        }),
      }),
    );
    expect(
      mockAppendLinkedScheduleRunMessagesToConversation,
    ).not.toHaveBeenCalled();
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "success",
      error: null,
    });
  });

  test("creates a linked chat on first successful run when keepResultsInSameChat is enabled", async () => {
    const createdConversationId = "00000000-0000-4000-8000-000000000123";
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(
      makeTrigger({ keepResultsInSameChat: true, linkedConversationId: null }),
    );
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockUserHasAgentAccess.mockResolvedValue(true);

    mockTxSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ linkedConversationId: null }]),
        }),
      }),
    });
    mockTxInsert.mockReturnValue({
      values: () => ({
        returning: () => Promise.resolve([{ id: createdConversationId }]),
      }),
    });
    mockTxUpdate.mockReturnValue({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    });

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockDbTransaction).toHaveBeenCalledTimes(1);
    expect(
      mockAppendLinkedScheduleRunMessagesToConversation,
    ).toHaveBeenCalledWith({
      conversationId: createdConversationId,
      messageTemplate: "Run the task",
      assistantText: "done",
    });
    expect(mockSetChatConversationId).toHaveBeenCalledWith(
      "run-1",
      createdConversationId,
    );
  });

  test("marks run success when linked conversation sync fails after successful execution", async () => {
    const linkedId = "00000000-0000-4000-8000-000000000002";
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(
      makeTrigger({ linkedConversationId: linkedId }),
    );
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockUserHasAgentAccess.mockResolvedValue(true);
    mockAppendLinkedScheduleRunMessagesToConversation.mockRejectedValue(
      new Error("db write failed"),
    );

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockExecuteA2AMessage).toHaveBeenCalled();
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "success",
      error: null,
    });
    expect(mockNotifyConversationMessagesUpdated).not.toHaveBeenCalled();
    expect(mockSetChatConversationId).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        triggerId: "trigger-1",
        linkedConversationId: linkedId,
        error: "db write failed",
      }),
      "Schedule trigger run succeeded but failed to sync messages to linked conversation",
    );
  });

  test("marks run as failed when trigger no longer exists", async () => {
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(null);

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "failed",
      error: "Trigger no longer exists",
    });
  });

  test("marks run as failed when actor user no longer exists", async () => {
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(makeTrigger());
    mockUserGetById.mockResolvedValue(null);

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "failed",
      error: "Scheduled trigger actor no longer exists",
    });
  });

  test("marks run as failed when actor lost agent access", async () => {
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(makeTrigger());
    mockUserGetById.mockResolvedValue(makeUser());
    mockUserHasAgentAccess.mockResolvedValue(false);

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "failed",
      error: "Scheduled trigger actor no longer has access to the target agent",
    });
  });

  test("marks run as failed when executeA2AMessage throws", async () => {
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(makeTrigger());
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockUserHasAgentAccess.mockResolvedValue(true);
    mockExecuteA2AMessage.mockRejectedValue(new Error("LLM provider down"));

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "failed",
      error: "LLM provider down",
    });
  });

  test("skips execution when run is not in running state", async () => {
    mockRunFindById.mockResolvedValue(makeRun({ status: "success" }));

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    expect(mockRunMarkCompleted).not.toHaveBeenCalled();
  });

  test("throws when payload is missing runId", async () => {
    await expect(
      handleScheduleTriggerRunExecution({ triggerId: "trigger-1" }),
    ).rejects.toThrow("Missing runId");
  });

  test("auto-heals when linked conversation no longer accepts the trigger agent (post-swap)", async () => {
    const linkedId = "00000000-0000-4000-8000-000000000099";
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(
      makeTrigger({ linkedConversationId: linkedId }),
    );
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockUserHasAgentAccess.mockResolvedValue(true);
    mockIsAgentValidForLinkedConversation.mockResolvedValue(false);

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockExecuteA2AMessage).toHaveBeenCalled();
    expect(
      mockAppendLinkedScheduleRunMessagesToConversation,
    ).not.toHaveBeenCalled();
    expect(mockSetChatConversationId).not.toHaveBeenCalled();
    expect(mockNotifyConversationMessagesUpdated).not.toHaveBeenCalled();
    expect(mockTriggerUpdate).toHaveBeenCalledWith("trigger-1", {
      linkedConversationId: null,
    });
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "success",
      error: expect.stringContaining("unlinked from the chat"),
    });
  });

  test("still marks run success even if auto-heal DB update fails", async () => {
    const linkedId = "00000000-0000-4000-8000-0000000000aa";
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(
      makeTrigger({ linkedConversationId: linkedId }),
    );
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockUserHasAgentAccess.mockResolvedValue(true);
    mockIsAgentValidForLinkedConversation.mockResolvedValue(false);
    mockTriggerUpdate.mockRejectedValue(new Error("db down"));

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(
      mockAppendLinkedScheduleRunMessagesToConversation,
    ).not.toHaveBeenCalled();
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "run-1",
      status: "success",
      error: expect.stringContaining("unlinked from the chat"),
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        triggerId: "trigger-1",
        error: "db down",
      }),
      "Failed to auto-heal schedule trigger linked conversation binding",
    );
  });
});
