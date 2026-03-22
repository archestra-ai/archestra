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

describe("Agent Scheduler Engine", () => {
  beforeEach(async () => {
    await db.delete(agentScheduleTriggerRunsTable);
    await db.delete(agentScheduleTriggersTable);
    await db.delete(schema.tasksTable);
  });

  test("Catch-up: creates one run per missed slot (bounded)", async () => {
    // 5 minutes ago, cron every minute
    const past = new Date(Date.now() - 5 * 60 * 1000); 
    const [trigger] = await db
      .insert(agentScheduleTriggersTable)
      .values({
        organizationId: "org-1",
        agentId: "agent-1",
        name: "Test Trigger",
        messageTemplate: "Run!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: "user-1",
        nextDueAt: past,
      })
      .returning();

    const createdCount = await runSchedulerTick();
    
    // It should create 5 or 6 runs depending on exact boundary, 
    // but definitely more than 1 if catch-up is working.
    expect(createdCount).toBeGreaterThanOrEqual(5);

    const runs = await db.select().from(agentScheduleTriggerRunsTable);
    expect(runs.length).toBe(createdCount);
    
    // Verify each run has a unique dueAt
    const dueAtSet = new Set(runs.map(r => r.dueAt!.getTime()));
    expect(dueAtSet.size).toBe(createdCount);

    const [updatedTrigger] = await db.select().from(agentScheduleTriggersTable).where({ id: trigger.id });
    expect(updatedTrigger.nextDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test("Backfill limit: does not process slots older than 24 hours", async () => {
    const wayPast = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago
    await db
      .insert(agentScheduleTriggersTable)
      .values({
        organizationId: "org-1",
        agentId: "agent-1",
        name: "Old Trigger",
        messageTemplate: "Run!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: "user-1",
        nextDueAt: wayPast,
      });

    await runSchedulerTick();

    const runs = await db.select().from(agentScheduleTriggerRunsTable);
    // Should only catch up for the last 24 hours @ 10 runs per tick limit
    expect(runs.length).toBeLessThanOrEqual(10);
    // The oldest run should NOT be 48 hours old
    const oldestRun = Math.min(...runs.map(r => r.dueAt!.getTime()));
    expect(oldestRun).toBeGreaterThan(wayPast.getTime());
  });
});
