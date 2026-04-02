import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockFindAllEnabled = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockMarkRan = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/models", () => ({
  AgentScheduleModel: {
    findAllEnabled: mockFindAllEnabled,
    markRan: mockMarkRan,
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

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  handleAgentScheduleRun,
  handleCheckDueAgentSchedules,
} from "./check-due-agent-schedules-handler";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeSchedule(overrides: object = {}) {
  return {
    id: "sched-1",
    agentId: "agent-1",
    cron: "* * * * *", // every minute
    message: "Run your daily summary",
    enabled: true,
    lastRunAt: new Date(Date.now() - 120_000), // 2 minutes ago → cron is due
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── handleCheckDueAgentSchedules ─────────────────────────────────────────────

describe("handleCheckDueAgentSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("does nothing when no schedules are enabled", async () => {
    mockFindAllEnabled.mockResolvedValue([]);

    await handleCheckDueAgentSchedules();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("enqueues agent_schedule_run when cron is due", async () => {
    mockFindAllEnabled.mockResolvedValue([fakeSchedule()]);

    await handleCheckDueAgentSchedules();

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "agent_schedule_run",
      payload: {
        scheduleId: "sched-1",
        agentId: "agent-1",
        message: "Run your daily summary",
      },
    });
  });

  test("does not enqueue when cron is not yet due", async () => {
    // lastRunAt is *just now* → cron hasn't fired yet
    mockFindAllEnabled.mockResolvedValue([
      fakeSchedule({ lastRunAt: new Date() }),
    ]);

    await handleCheckDueAgentSchedules();

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("fires immediately when lastRunAt is null (never ran)", async () => {
    mockFindAllEnabled.mockResolvedValue([
      fakeSchedule({ lastRunAt: null }),
    ]);

    await handleCheckDueAgentSchedules();

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  test("continues processing other schedules when one has an invalid cron", async () => {
    mockFindAllEnabled.mockResolvedValue([
      fakeSchedule({ id: "bad-sched", cron: "INVALID_CRON" }),
      fakeSchedule({ id: "good-sched" }),
    ]);

    await handleCheckDueAgentSchedules();

    // Only the good schedule should have been enqueued
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ scheduleId: "good-sched" }) }),
    );
  });

  test("processes multiple schedules independently", async () => {
    mockFindAllEnabled.mockResolvedValue([
      fakeSchedule({ id: "sched-a", agentId: "agent-a" }),
      fakeSchedule({ id: "sched-b", agentId: "agent-b" }),
    ]);

    await handleCheckDueAgentSchedules();

    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });
});

// ── handleAgentScheduleRun ───────────────────────────────────────────────────

describe("handleAgentScheduleRun", () => {
  const validPayload = {
    scheduleId: "sched-1",
    agentId: "agent-1",
    message: "hello",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Stub global fetch
    vi.stubGlobal("fetch", vi.fn());
  });

  test("throws when required payload fields are missing", async () => {
    await expect(
      handleAgentScheduleRun({ scheduleId: "s", agentId: "a" }),
    ).rejects.toThrow("Missing required payload fields");
  });

  test("calls the gateway and marks the schedule as ran on success", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    } as Response);

    await handleAgentScheduleRun(validPayload);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/agents/agent-1/messages`),
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockMarkRan).toHaveBeenCalledWith("sched-1", expect.any(Date));
  });

  test("throws and does not markRan when gateway returns error", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as Response);

    await expect(handleAgentScheduleRun(validPayload)).rejects.toThrow(
      "Gateway returned 500",
    );
    expect(mockMarkRan).not.toHaveBeenCalled();
  });

  test("throws and does not markRan when fetch itself fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    await expect(handleAgentScheduleRun(validPayload)).rejects.toThrow(
      "Network error",
    );
    expect(mockMarkRan).not.toHaveBeenCalled();
  });
});
