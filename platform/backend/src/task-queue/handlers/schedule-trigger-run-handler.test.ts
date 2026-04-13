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

vi.mock("@/models", () => ({
  ScheduleTriggerRunModel: {
    findById: mockRunFindById,
    markCompleted: mockRunMarkCompleted,
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
    mockTriggerFindById.mockResolvedValue(null);
    mockUserGetById.mockResolvedValue(null);
    mockAgentFindById.mockResolvedValue(null);
    mockUserHasAgentAccess.mockResolvedValue(true);
    mockHasAnyAgentTypeAdminPermission.mockResolvedValue({ success: false });
    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "msg-1",
      text: "done",
    });
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
});
