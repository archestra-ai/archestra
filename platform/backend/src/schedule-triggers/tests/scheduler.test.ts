import { vi } from "vitest";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import { scheduleTriggersTable } from "../models/schedule-trigger";
import { scheduleTriggerRunsTable } from "../models/schedule-trigger-run";
import { runSchedulerTick } from "../scheduler/scheduler";

// We mock the enqueue internally by tracking db inserts to schema.tasksTable,
// but the prompt says to mock taskQueueService. We can mock it anyway just in case.
vi.mock("@/task-queue/task-queue", () => ({
  taskQueueService: {
    enqueue: vi.fn(),
    registerHandler: vi.fn(),
  },
}));

describe("Scheduler", () => {
  beforeEach(async () => {
    await db.delete(scheduleTriggerRunsTable);
    await db.delete(scheduleTriggersTable);
    await db.delete(schema.tasksTable);
  });

  test("1. Scheduler creates runs for due triggers", async () => {
    // Create a trigger that is due
    const [trigger] = await db
      .insert(scheduleTriggersTable)
      .values({
        organizationId: "org-1",
        agentId: "agent-1",
        name: "Test Trigger",
        messageTemplate: "Run now!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: "user-1",
        nextDueAt: new Date(Date.now() - 10000), // Due 10 seconds ago
      })
      .returning();

    const processed = await runSchedulerTick();
    expect(processed).toBe(1);

    // Verify run snapshot created
    const runs = await db.select().from(scheduleTriggerRunsTable);
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerId).toBe(trigger.id);
    expect(runs[0].agentIdSnapshot).toBe("agent-1");
    expect(runs[0].status).toBe("pending");

    // Verify trigger next_due_at advanced
    const [updatedTrigger] = await db
      .select()
      .from(scheduleTriggersTable)
      .where({ id: trigger.id });
    expect(updatedTrigger.nextDueAt?.getTime()).toBeGreaterThan(
      trigger.nextDueAt!.getTime(),
    );

    // Verify task enqueued via db insert
    const tasks = await db.select().from(schema.tasksTable);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskType).toBe("schedule_trigger_run_execute");
    expect((tasks[0].payload as any).runId).toBe(runs[0].id);
  });

  test("2. Scheduler does NOT duplicate runs", async () => {
    const dueAt = new Date(Date.now() - 10000);
    const [trigger] = await db
      .insert(scheduleTriggersTable)
      .values({
        organizationId: "org-1",
        agentId: "agent-1",
        name: "Test Trigger",
        messageTemplate: "Run now!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: "user-1",
        nextDueAt: dueAt,
      })
      .returning();

    // Manually insert a run with the SAME dueAt to simulate an existing scheduled run
    await db.insert(scheduleTriggerRunsTable).values({
      triggerId: trigger.id,
      organizationId: trigger.organizationId,
      runKind: "scheduled",
      status: "pending",
      dueAt: dueAt,
      agentIdSnapshot: trigger.agentId,
      messageTemplateSnapshot: trigger.messageTemplate,
      actorUserIdSnapshot: trigger.actorUserId,
      cronExpressionSnapshot: trigger.cronExpression,
      timezoneSnapshot: trigger.timezone,
    });

    // Run scheduler tick. The trigger's next_due_at is still dueAt.
    // It should hit the unique constraint and gracefully skip duplicating the run, but still advance the schedule.
    const processed = await runSchedulerTick();
    expect(processed).toBe(0);

    const runs = await db.select().from(scheduleTriggerRunsTable);
    expect(runs).toHaveLength(1); // Still only 1

    const [updatedTrigger] = await db
      .select()
      .from(scheduleTriggersTable)
      .where({ id: trigger.id });
    // Expect nextDueAt to be advanced despite the duplicate skip
    expect(updatedTrigger.nextDueAt?.getTime()).toBeGreaterThan(
      dueAt.getTime(),
    );
  });
});
