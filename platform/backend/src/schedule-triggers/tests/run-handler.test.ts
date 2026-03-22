import { vi } from "vitest";
import db from "@/database";
import { AgentModel, UserModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { agentScheduleTriggersTable } from "../models/agent-schedule-trigger";
import { agentScheduleTriggerRunsTable } from "../models/agent-schedule-trigger-run";
import { scheduleTriggerRunExecuteHandler } from "../queue/agent-schedule-trigger-run-handler";

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
    await db.delete(agentScheduleTriggerRunsTable);
    await db.delete(agentScheduleTriggersTable);
    await UserModel.deleteMany({});
    await AgentModel.deleteMany({});

    const user = await UserModel.create({ organizationId: orgId, name: "Test User", email: "test@example.com" });
    userId = user.id;

    const agent = await AgentModel.create({ organizationId: orgId, name: "Test Agent", authorId: userId, scope: "personal" });
    agentId = agent.id;

    const [trigger] = await db.insert(agentScheduleTriggersTable).values({
        organizationId: orgId,
        agentId,
        name: "Test Trigger",
        messageTemplate: "Run now!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: userId,
    }).returning();
    triggerId = trigger.id;

    const [run] = await db.insert(agentScheduleTriggerRunsTable).values({
        triggerId: trigger.id,
        organizationId: orgId,
        runKind: "scheduled",
        status: "pending",
        dueAt: new Date(),
        agentIdSnapshot: agentId,
        messageTemplateSnapshot: "Run now!",
        actorUserIdSnapshot: userId,
      }).returning();
    runId = run.id;
  });

  test("Worker executes run with 'schedule' source", async () => {
    await scheduleTriggerRunExecuteHandler({ runId });

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "schedule",
      }),
    );

    const [run] = await db.select().from(agentScheduleTriggerRunsTable).where({ id: runId });
    expect(run.status).toBe("success");
  });
});
