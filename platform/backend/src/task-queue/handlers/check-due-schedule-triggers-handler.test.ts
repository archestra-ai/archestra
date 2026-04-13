import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFindDueTriggers = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockMarkExecuted = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockHasPendingOrProcessingForTrigger = vi.hoisted(() =>
  vi.fn().mockResolvedValue(false),
);
const mockRunCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: "run-1" }),
);
const mockRunMarkCompleted = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("@/models", () => ({
  ScheduleTriggerModel: {
    findDueTriggers: mockFindDueTriggers,
    markExecuted: mockMarkExecuted,
  },
  TaskModel: {
    hasPendingOrProcessingForTrigger: mockHasPendingOrProcessingForTrigger,
  },
  ScheduleTriggerRunModel: {
    create: mockRunCreate,
    markCompleted: mockRunMarkCompleted,
  },
}));

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { handleCheckDueScheduleTriggers } from "./check-due-schedule-triggers-handler";

const makeTrigger = (id: string) => ({
  id,
  organizationId: "org-1",
  name: `Trigger ${id}`,
  agentId: "agent-1",
  messageTemplate: "Run task",
  cronExpression: "* * * * *",
  timezone: "UTC",
  enabled: true,
  actorUserId: "user-1",
  lastExecutedAt: null,
  createdAt: new Date(),
});

describe("handleCheckDueScheduleTriggers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("does nothing when no triggers are due", async () => {
    mockFindDueTriggers.mockResolvedValue([]);

    await handleCheckDueScheduleTriggers();

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockRunCreate).not.toHaveBeenCalled();
  });

  test("creates run, marks executed, and enqueues task for due trigger", async () => {
    const trigger = makeTrigger("t-1");
    mockFindDueTriggers.mockResolvedValue([trigger]);
    mockHasPendingOrProcessingForTrigger.mockResolvedValue(false);
    mockRunCreate.mockResolvedValue({ id: "run-1" });

    await handleCheckDueScheduleTriggers();

    expect(mockRunCreate).toHaveBeenCalledWith({
      organizationId: "org-1",
      triggerId: "t-1",
      runKind: "due",
    });
    expect(mockMarkExecuted).toHaveBeenCalledWith("t-1", expect.any(Date));
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "schedule_trigger_run_execute",
      payload: { runId: "run-1", triggerId: "t-1" },
    });
  });

  test("creates failed run and skips enqueue when task already in flight", async () => {
    const trigger = makeTrigger("t-1");
    mockFindDueTriggers.mockResolvedValue([trigger]);
    mockHasPendingOrProcessingForTrigger.mockResolvedValue(true);
    mockRunCreate.mockResolvedValue({ id: "skipped-run" });

    await handleCheckDueScheduleTriggers();

    expect(mockRunCreate).toHaveBeenCalledWith({
      organizationId: "org-1",
      triggerId: "t-1",
      runKind: "due",
    });
    expect(mockRunMarkCompleted).toHaveBeenCalledWith({
      runId: "skipped-run",
      status: "failed",
      error: "Skipped: previous run was still in progress",
    });
    expect(mockMarkExecuted).toHaveBeenCalledWith("t-1", expect.any(Date));
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("continues processing when one trigger fails", async () => {
    const badTrigger = makeTrigger("t-bad");
    const goodTrigger = makeTrigger("t-good");
    mockFindDueTriggers.mockResolvedValue([badTrigger, goodTrigger]);
    mockHasPendingOrProcessingForTrigger.mockResolvedValue(false);

    // First create call throws, second succeeds
    mockRunCreate
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce({ id: "run-good" });

    await handleCheckDueScheduleTriggers();

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "schedule_trigger_run_execute",
      payload: { runId: "run-good", triggerId: "t-good" },
    });
  });
});
