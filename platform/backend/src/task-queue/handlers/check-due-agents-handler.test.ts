import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFindAllScheduled = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockHasPendingOrProcessingForAgent = vi.hoisted(() =>
  vi.fn().mockResolvedValue(false),
);
vi.mock("@/models", () => ({
  AgentModel: {
    findAllScheduled: mockFindAllScheduled,
  },
  TaskModel: { hasPendingOrProcessingForAgent: mockHasPendingOrProcessingForAgent },
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

import { handleCheckDueAgents } from "./check-due-agents-handler";

describe("handleCheckDueAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("does nothing when no agents are scheduled", async () => {
    mockFindAllScheduled.mockResolvedValue([]);

    await handleCheckDueAgents();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("enqueues agent run when cron is due", async () => {
    const pastDate = new Date(Date.now() - 120_000);
    mockFindAllScheduled.mockResolvedValue([
      {
        id: "agent-1",
        name: "Agent 1",
        schedule: "* * * * *", // every minute
        lastScheduledRunAt: pastDate,
      },
    ]);
    mockHasPendingOrProcessingForAgent.mockResolvedValue(false);

    await handleCheckDueAgents();

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "agent_run",
      payload: { agentId: "agent-1" },
    });
  });

  test("does not enqueue when a pending task already exists", async () => {
    const pastDate = new Date(Date.now() - 120_000);
    mockFindAllScheduled.mockResolvedValue([
      {
        id: "agent-1",
        name: "Agent 1",
        schedule: "* * * * *",
        lastScheduledRunAt: pastDate,
      },
    ]);
    mockHasPendingOrProcessingForAgent.mockResolvedValue(true);

    await handleCheckDueAgents();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("handles invalid cron expressions gracefully", async () => {
    mockFindAllScheduled.mockResolvedValue([
      {
        id: "agent-bad",
        name: "Bad Agent",
        schedule: "INVALID_CRON",
        lastScheduledRunAt: null,
      },
      {
        id: "agent-good",
        name: "Good Agent",
        schedule: "* * * * *",
        lastScheduledRunAt: null,
      },
    ]);
    mockHasPendingOrProcessingForAgent.mockResolvedValue(false);

    await handleCheckDueAgents();

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "agent_run",
      payload: { agentId: "agent-good" },
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
});
