import { vi } from "vitest";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import { agentScheduleTriggersTable } from "../models/agent-schedule-trigger";
import { agentScheduleTriggerRunsTable } from "../models/agent-schedule-trigger-run";
import { runSchedulerTick } from "../scheduler/scheduler";

vi.mock("@/task-queue/task-queue", () => ({
  taskQueueService: {
    enqueue: vi.fn(),
    registerHandler: vi.fn(),
  },
}));

describe("Agent Scheduler", () => {
  beforeEach(async () => {
    await db.delete(agentScheduleTriggerRunsTable);
    await db.delete(agentScheduleTriggersTable);
    await db.delete(schema.tasksTable);
  });

  test("Scheduler creates runs for due triggers and handles missed schedules", async () => {
    const past = new Date(Date.now() - 3600000); // 1 hour ago
    const [trigger] = await db
      .insert(agentScheduleTriggersTable)
      .values({
        organizationId: "org-1",
        agentId: "agent-1",
        name: "Test Trigger",
        messageTemplate: "Run now!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: "user-1",
        nextDueAt: past,
      })
      .returning();

    const processed = await runSchedulerTick();
    expect(processed).toBe(1);

    const runs = await db.select().from(agentScheduleTriggerRunsTable);
    expect(runs).toHaveLength(1);
    expect(runs[0].dueAt!.getTime()).toBe(past.getTime());

    const [updatedTrigger] = await db.select().from(agentScheduleTriggersTable).where({ id: trigger.id });
    // Should be advanced to next interval after NOW
    expect(updatedTrigger.nextDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test("Scheduler prevents duplicate runs for same trigger and timestamp", async () => {
    const dueAt = new Date(Date.now() - 10000);
    const [trigger] = await db.insert(agentScheduleTriggersTable).values({
        organizationId: "org-1",
        agentId: "agent-1",
        name: "Test Trigger",
        messageTemplate: "Run now!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: "user-1",
        nextDueAt: dueAt,
    }).returning();

    await db.insert(agentScheduleTriggerRunsTable).values({
      triggerId: trigger.id,
      organizationId: trigger.organizationId,
      runKind: "scheduled",
      status: "pending",
      dueAt: dueAt,
      agentIdSnapshot: trigger.agentId,
      messageTemplateSnapshot: trigger.messageTemplate,
      actorUserIdSnapshot: trigger.actorUserId,
    });

    const processed = await runSchedulerTick();
    expect(processed).toBe(0); // Constraint catch handled it
  });
});
