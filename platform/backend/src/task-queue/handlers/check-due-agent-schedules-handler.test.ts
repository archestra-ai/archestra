import { describe, expect, vi } from "vitest";
import { AgentScheduleTriggerModel } from "@/models";
import { test } from "@/test";
import { handleCheckDueAgentSchedules } from "./check-due-agent-schedules-handler";

// Mock taskQueueService to capture enqueued tasks
vi.mock("@/task-queue", () => ({
  taskQueueService: {
    enqueue: vi.fn().mockResolvedValue("mock-task-id"),
  },
}));

describe("handleCheckDueAgentSchedules", () => {
  test("enqueues execution for due triggers", async ({ makeInternalAgent }) => {
    const agent = await makeInternalAgent();

    await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Due Trigger",
      triggerType: "cron",
      cronExpression: "* * * * *",
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(Date.now() - 60_000),
      intervalSeconds: null,
      scheduledAt: null,
      message: "",
      lastExecutedAt: null,
      lastError: null,
    });

    const { taskQueueService } = await import("@/task-queue");

    await handleCheckDueAgentSchedules();

    expect(taskQueueService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: "execute_agent_schedule",
      }),
    );
  });

  test("does not enqueue for future triggers", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent();

    await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Future Trigger",
      triggerType: "interval",
      intervalSeconds: 3600,
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(Date.now() + 3_600_000),
      cronExpression: undefined,
      scheduledAt: undefined,
      message: "",
      lastExecutedAt: null,
      lastError: null,
    });

    const { taskQueueService } = await import("@/task-queue");
    vi.mocked(taskQueueService.enqueue).mockClear();

    await handleCheckDueAgentSchedules();

    expect(taskQueueService.enqueue).not.toHaveBeenCalled();
  });
});
