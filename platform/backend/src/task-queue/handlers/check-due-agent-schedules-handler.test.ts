import { describe, expect, test, vi, beforeEach } from "vitest";
import { handleCheckDueAgentSchedules } from "./check-due-agent-schedules-handler";
import { AgentModel, AgentScheduleModel } from "@/models";
import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";

vi.mock("@/models", () => ({
  AgentModel: {
    findById: vi.fn(),
  },
  AgentScheduleModel: {
    findAllDue: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: vi.fn(),
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("handleCheckDueAgentSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("successfully executes a due schedule", async () => {
    const mockSchedule = {
      id: "schedule-1",
      agentId: "agent-1",
      cron: "* * * * *",
      payload: "test-payload",
      isActive: true,
      nextRunAt: new Date(),
    };

    const mockAgent = {
      id: "agent-1",
      organizationId: "org-1",
      authorId: "user-1",
      name: "Test Agent",
    };

    vi.mocked(AgentScheduleModel.findAllDue).mockResolvedValue([mockSchedule as any]);
    vi.mocked(AgentModel.findById).mockResolvedValue(mockAgent as any);
    vi.mocked(executeA2AMessage).mockResolvedValue({ text: "Success" } as any);

    await handleCheckDueAgentSchedules();

    expect(executeA2AMessage).toHaveBeenCalledWith({
      agentId: "agent-1",
      message: "test-payload",
      organizationId: "org-1",
      userId: "user-1",
      source: "api",
    });

    // Should update lastRunAt and nextRunAt
    expect(AgentScheduleModel.update).toHaveBeenCalledWith("schedule-1", expect.objectContaining({
      lastRunAt: expect.any(Date),
      nextRunAt: expect.any(Date),
    }));
  });

  test("deactivates schedule if agent is not found", async () => {
    const mockSchedule = {
      id: "schedule-1",
      agentId: "agent-1",
      isActive: true,
    };

    vi.mocked(AgentScheduleModel.findAllDue).mockResolvedValue([mockSchedule as any]);
    vi.mocked(AgentModel.findById).mockResolvedValue(null);

    await handleCheckDueAgentSchedules();

    expect(AgentScheduleModel.update).toHaveBeenCalledWith("schedule-1", { isActive: false });
    expect(executeA2AMessage).not.toHaveBeenCalled();
  });

  test("deactivates schedule if agent has no authorId", async () => {
    const mockSchedule = {
      id: "schedule-1",
      agentId: "agent-1",
      isActive: true,
    };

    const mockAgent = {
      id: "agent-1",
      authorId: null,
    };

    vi.mocked(AgentScheduleModel.findAllDue).mockResolvedValue([mockSchedule as any]);
    vi.mocked(AgentModel.findById).mockResolvedValue(mockAgent as any);

    await handleCheckDueAgentSchedules();

    expect(AgentScheduleModel.update).toHaveBeenCalledWith("schedule-1", { isActive: false });
    expect(executeA2AMessage).not.toHaveBeenCalled();
  });

  test("updates nextRunAt even if execution fails", async () => {
    const mockSchedule = {
      id: "schedule-1",
      agentId: "agent-1",
      cron: "* * * * *",
      isActive: true,
    };

    const mockAgent = {
      id: "agent-1",
      authorId: "user-1",
    };

    vi.mocked(AgentScheduleModel.findAllDue).mockResolvedValue([mockSchedule as any]);
    vi.mocked(AgentModel.findById).mockResolvedValue(mockAgent as any);
    vi.mocked(executeA2AMessage).mockRejectedValue(new Error("Execution failed"));

    await handleCheckDueAgentSchedules();

    // Still updates nextRunAt to avoid immediate retry
    expect(AgentScheduleModel.update).toHaveBeenCalledWith("schedule-1", expect.objectContaining({
      nextRunAt: expect.any(Date),
    }));
    expect(logger.error).toHaveBeenCalled();
  });

  test("deactivates schedule if cron expression is invalid during nextRun calculation", async () => {
     const mockSchedule = {
      id: "schedule-1",
      agentId: "agent-1",
      cron: "invalid-cron",
      isActive: true,
    };

    const mockAgent = {
      id: "agent-1",
      authorId: "user-1",
    };

    vi.mocked(AgentScheduleModel.findAllDue).mockResolvedValue([mockSchedule as any]);
    vi.mocked(AgentModel.findById).mockResolvedValue(mockAgent as any);
    vi.mocked(executeA2AMessage).mockResolvedValue({ text: "Success" } as any);

    await handleCheckDueAgentSchedules();

    expect(AgentScheduleModel.update).toHaveBeenCalledWith("schedule-1", { isActive: false });
  });
});
