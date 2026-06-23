import { beforeEach, describe, expect, test, vi } from "vitest";

const mockRunFindById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockRunMarkCompleted = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockRunSetChatConversationId = vi.hoisted(() =>
  vi.fn().mockResolvedValue(true),
);
const mockTriggerFindById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockUserGetById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockAgentFindById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockUserHasAgentAccess = vi.hoisted(() =>
  vi.fn().mockResolvedValue(true),
);
const mockHasAnyAgentTypeAdminPermission = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: false }),
);

vi.mock("@/models", () => ({
  ScheduleTriggerRunModel: {
    findById: mockRunFindById,
    markCompleted: mockRunMarkCompleted,
    setChatConversationId: mockRunSetChatConversationId,
  },
  ScheduleTriggerModel: {
    findById: mockTriggerFindById,
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
}));

vi.mock("@/auth", () => ({
  hasAnyAgentTypeAdminPermission: mockHasAnyAgentTypeAdminPermission,
}));

const mockEnsureTriggerConversation = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: "conv-1", userId: "user-1" }),
);
const mockAppendRunMessages = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockSyncRunArtifact = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("@/services/scheduled-run-conversation", () => ({
  ensureTriggerConversation: mockEnsureTriggerConversation,
  appendRunMessagesToConversation: mockAppendRunMessages,
  syncRunArtifactToConversation: mockSyncRunArtifact,
}));

// Run the transaction callback inline with a dummy handle so the unit test needs
// no real database connection. Preserve the real module's other exports (the
// global test setup relies on __setTestDb).
const mockWithDbTransaction = vi.hoisted(() =>
  vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
);
vi.mock("@/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/database")>()),
  withDbTransaction: mockWithDbTransaction,
}));

const mockExecuteA2AMessage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "msg-1", text: "done" }),
);
vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: mockExecuteA2AMessage,
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

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
    mockRunSetChatConversationId.mockResolvedValue(true);
    mockTriggerFindById.mockResolvedValue(null);
    mockUserGetById.mockResolvedValue(null);
    mockAgentFindById.mockResolvedValue(null);
    mockUserHasAgentAccess.mockResolvedValue(true);
    mockHasAnyAgentTypeAdminPermission.mockResolvedValue({ success: false });
    mockEnsureTriggerConversation.mockResolvedValue({
      id: "conv-1",
      userId: "user-1",
    });
    mockAppendRunMessages.mockResolvedValue(undefined);
    mockSyncRunArtifact.mockResolvedValue(undefined);
    mockWithDbTransaction.mockImplementation(async (cb) => cb({}));
    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "msg-1",
      text: "done",
    });
  });

  test("wraps the run in the schedule's chat, executes against it, and appends its turn", async () => {
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(makeTrigger());
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockUserHasAgentAccess.mockResolvedValue(true);
    // The CAS win (a real run row) gates the message append.
    mockRunMarkCompleted.mockResolvedValue(makeRun({ status: "success" }));

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockEnsureTriggerConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ id: "trigger-1" }),
        ownerUserId: "user-1",
        organizationId: "org-1",
      }),
    );
    // The run links to (and executes against) the shared conversation.
    expect(mockRunSetChatConversationId).toHaveBeenCalledWith(
      "run-1",
      "conv-1",
    );
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        message: "Run the task",
        organizationId: "org-1",
        userId: "user-1",
        sessionId: "scheduled-run-1",
        conversationId: "conv-1",
        source: "schedule-trigger",
      }),
    );
    // markCompleted is the CAS inside the persistence transaction.
    expect(mockRunMarkCompleted).toHaveBeenCalledWith(
      { runId: "run-1", status: "success", error: null },
      expect.anything(),
    );
    expect(mockAppendRunMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: "conv-1" }),
        run: expect.objectContaining({ id: "run-1" }),
      }),
      expect.anything(),
    );
    expect(mockSyncRunArtifact).toHaveBeenCalled();
  });

  test("does not append messages when another worker already completed the run", async () => {
    mockRunFindById.mockResolvedValue(makeRun());
    mockTriggerFindById.mockResolvedValue(makeTrigger());
    mockUserGetById.mockResolvedValue(makeUser());
    mockAgentFindById.mockResolvedValue(makeAgent());
    mockUserHasAgentAccess.mockResolvedValue(true);
    // CAS lost: the run was already flipped out of `running`, so markCompleted
    // returns null, the transaction rolls back, and the turn must not be
    // appended (nor the artifact synced) a second time.
    mockRunMarkCompleted.mockResolvedValue(null);

    await handleScheduleTriggerRunExecution({
      runId: "run-1",
      triggerId: "trigger-1",
    });

    expect(mockExecuteA2AMessage).toHaveBeenCalled();
    expect(mockAppendRunMessages).not.toHaveBeenCalled();
    expect(mockSyncRunArtifact).not.toHaveBeenCalled();
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
    // A failed run has no successful turn to wrap into the chat.
    expect(mockAppendRunMessages).not.toHaveBeenCalled();
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
});
