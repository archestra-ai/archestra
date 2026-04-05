import { beforeEach, describe, expect, test, vi } from "vitest";

const mockListDueTriggers = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockAcquireTriggerLock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockGetTrigger = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockUpdateTrigger = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockCountPendingOrProcessingAgentExecution = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ pending: 0, processing: 0 }),
);

vi.mock("@/models", () => ({
  AgentScheduleModel: {
    listDueTriggers: mockListDueTriggers,
    acquireTriggerLock: mockAcquireTriggerLock,
    getTrigger: mockGetTrigger,
    updateTrigger: mockUpdateTrigger,
  },
  TaskModel: {
    countPendingOrProcessingAgentExecution:
      mockCountPendingOrProcessingAgentExecution,
    hasPendingOrProcessing: vi.fn(),
  },
}));

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

vi.mock("@/database", () => ({
  default: {
    transaction: vi.fn((cb) => cb({})),
  },
  schema: {},
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { handleCheckDueAgents } from "./check-due-agents-handler";

describe("handleCheckDueAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("does nothing when no triggers are due", async () => {
    mockListDueTriggers.mockResolvedValue([]);

    await handleCheckDueAgents();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("enqueues agent execution when cron is due", async () => {
    const trigger = {
      id: "trigger-1",
      agentId: "agent-1",
      cron: "* * * * *",
      status: "active",
      nextRunAt: new Date(Date.now() - 1000),
      overlapPolicy: "allow_all",
      payload: { message: "hi", userId: "u1", organizationId: "o1" },
    };
    mockListDueTriggers.mockResolvedValue([trigger]);
    mockAcquireTriggerLock.mockResolvedValue(true);
    mockGetTrigger.mockResolvedValue(trigger);
    mockCountPendingOrProcessingAgentExecution.mockResolvedValue({
      pending: 0,
      processing: 0,
    });

    await handleCheckDueAgents();

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: "agent_execution",
        payload: { triggerId: "trigger-1" },
      }),
      expect.anything(),
    );
    expect(mockUpdateTrigger).toHaveBeenCalledWith(
      "trigger-1",
      expect.objectContaining({
        nextRunAt: expect.any(Date),
        lastRunAt: expect.any(Date),
      }),
      expect.anything(),
    );
  });

  test("skips when lock cannot be acquired", async () => {
    const trigger = {
      id: "trigger-1",
      agentId: "agent-1",
      cron: "* * * * *",
      status: "active",
      nextRunAt: new Date(Date.now() - 1000),
      overlapPolicy: "allow_all",
    };
    mockListDueTriggers.mockResolvedValue([trigger]);
    mockAcquireTriggerLock.mockResolvedValue(false);

    await handleCheckDueAgents();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("skips due to overlap policy 'skip'", async () => {
    const trigger = {
      id: "trigger-1",
      agentId: "agent-1",
      cron: "* * * * *",
      status: "active",
      nextRunAt: new Date(Date.now() - 1000),
      overlapPolicy: "skip",
      payload: { message: "hi", userId: "u1", organizationId: "o1" },
    };
    mockListDueTriggers.mockResolvedValue([trigger]);
    mockAcquireTriggerLock.mockResolvedValue(true);
    mockGetTrigger.mockResolvedValue(trigger);
    mockCountPendingOrProcessingAgentExecution.mockResolvedValue({
      pending: 0,
      processing: 1,
    });

    await handleCheckDueAgents();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("skips due to overlap policy 'buffer_one' when a task is already pending", async () => {
    const trigger = {
      id: "trigger-1",
      agentId: "agent-1",
      cron: "* * * * *",
      status: "active",
      nextRunAt: new Date(Date.now() - 1000),
      overlapPolicy: "buffer_one",
      payload: { message: "hi", userId: "u1", organizationId: "o1" },
    };
    mockListDueTriggers.mockResolvedValue([trigger]);
    mockAcquireTriggerLock.mockResolvedValue(true);
    mockGetTrigger.mockResolvedValue(trigger);
    mockCountPendingOrProcessingAgentExecution.mockResolvedValue({
      pending: 1,
      processing: 1,
    });

    await handleCheckDueAgents();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("allows execution due to overlap policy 'buffer_one' when a task is processing but none pending", async () => {
    const trigger = {
      id: "trigger-1",
      agentId: "agent-1",
      cron: "* * * * *",
      status: "active",
      nextRunAt: new Date(Date.now() - 1000),
      overlapPolicy: "buffer_one",
      payload: { message: "hi", userId: "u1", organizationId: "o1" },
    };
    mockListDueTriggers.mockResolvedValue([trigger]);
    mockAcquireTriggerLock.mockResolvedValue(true);
    mockGetTrigger.mockResolvedValue(trigger);
    mockCountPendingOrProcessingAgentExecution.mockResolvedValue({
      pending: 0,
      processing: 1,
    });

    await handleCheckDueAgents();

    expect(mockEnqueue).toHaveBeenCalled();
  });
});
