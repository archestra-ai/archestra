import { vi } from "vitest";
import db from "@/database";
import { AgentModel, UserModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { scheduleTriggersTable } from "../models/schedule-trigger";
import { scheduleTriggerRunsTable } from "../models/schedule-trigger-run";
import { scheduleTriggerRunExecuteHandler } from "../queue/schedule-trigger-run-handler";

const mockExecuteA2AMessage = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: mockExecuteA2AMessage,
}));

describe("Run Handler", () => {
  let triggerId: string;
  let runId: string;
  const orgId = "org-handler-test";
  let userId: string;
  let agentId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(scheduleTriggerRunsTable);
    await db.delete(scheduleTriggersTable);
    await UserModel.deleteMany({});
    await AgentModel.deleteMany({});

    const user = await UserModel.create({
      organizationId: orgId,
      name: "Test User",
      email: "test@example.com",
    });
    userId = user.id;

    const agent = await AgentModel.create({
      organizationId: orgId,
      name: "Test Agent",
      authorId: userId,
      scope: "personal",
    });
    agentId = agent.id;

    const [trigger] = await db
      .insert(scheduleTriggersTable)
      .values({
        organizationId: orgId,
        agentId,
        name: "Test Trigger",
        messageTemplate: "Run now!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: userId,
      })
      .returning();
    triggerId = trigger.id;

    const [run] = await db
      .insert(scheduleTriggerRunsTable)
      .values({
        triggerId: trigger.id,
        organizationId: orgId,
        runKind: "scheduled",
        status: "pending",
        dueAt: new Date(),
        agentIdSnapshot: agentId,
        messageTemplateSnapshot: "Run now!",
        actorUserIdSnapshot: userId,
        cronExpressionSnapshot: "* * * * *",
        timezoneSnapshot: "UTC",
      })
      .returning();
    runId = run.id;
  });

  test("3. Worker executes run successfully", async () => {
    await scheduleTriggerRunExecuteHandler({ runId });

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId,
        userId,
        organizationId: orgId,
        message: "Run now!",
        source: "api",
      }),
    );

    const [run] = await db
      .select()
      .from(scheduleTriggerRunsTable)
      .where({ id: runId });
    expect(run.status).toBe("success");
    expect(run.completedAt).not.toBeNull();
    expect(run.error).toBeNull();

    const [trigger] = await db
      .select()
      .from(scheduleTriggersTable)
      .where({ id: triggerId });
    expect(trigger.lastRunStatus).toBe("success");
  });

  test("4. Worker handles failure correctly", async () => {
    mockExecuteA2AMessage.mockRejectedValueOnce(new Error("LLM timeout"));

    await scheduleTriggerRunExecuteHandler({ runId });

    const [run] = await db
      .select()
      .from(scheduleTriggerRunsTable)
      .where({ id: runId });
    expect(run.status).toBe("failed");
    expect(run.error).toBe("LLM timeout");

    const [trigger] = await db
      .select()
      .from(scheduleTriggersTable)
      .where({ id: triggerId });
    expect(trigger.lastRunStatus).toBe("failed");
    expect(trigger.lastError).toBe("LLM timeout");
  });

  test("Worker handles failure when user loses access", async () => {
    // Delete the agent to simulate lost access/deleted resource
    await AgentModel.delete(agentId);

    await scheduleTriggerRunExecuteHandler({ runId });

    // The run should be marked failed gracefully
    const [run] = await db
      .select()
      .from(scheduleTriggerRunsTable)
      .where({ id: runId });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Agent");
    expect(run.error).toContain("not found");
  });
});
