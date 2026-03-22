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

describe("Agent Scheduler Engine (Extended Kinds)", () => {
  beforeEach(async () => {
    await db.delete(agentScheduleTriggerRunsTable);
    await db.delete(agentScheduleTriggersTable);
    await db.delete(schema.tasksTable);
  });

  test("Interval: enqueues and advances by seconds", async () => {
    const past = new Date(Date.now() - 10000); 
    await db.insert(agentScheduleTriggersTable).values({
        organizationId: "org-1",
        agentId: "agent-1",
        name: "Interval Trigger",
        messageTemplate: "Run!",
        scheduleKind: "interval",
        intervalSeconds: 60,
        enabled: true,
        actorUserId: "user-1",
        nextDueAt: past,
    });

    const count = await runSchedulerTick();
    expect(count).toBe(1);

    const [trigger] = await db.select().from(agentScheduleTriggersTable);
    // nextDueAt should be approx now + 60s (not exactly past + 60s because of drift prevention)
    expect(trigger.nextDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test("One-time: enqueues and disables trigger", async () => {
    const past = new Date(Date.now() - 10000);
    await db.insert(agentScheduleTriggersTable).values({
        organizationId: "org-1",
        agentId: "agent-1",
        name: "One-time Trigger",
        messageTemplate: "Run!",
        scheduleKind: "one-time",
        runAt: past,
        enabled: true,
        actorUserId: "user-1",
        nextDueAt: past,
    });

    const count = await runSchedulerTick();
    expect(count).toBe(1);

    const [trigger] = await db.select().from(agentScheduleTriggersTable);
    expect(trigger.enabled).toBe(false);
    expect(trigger.nextDueAt).toBeNull();
  });
});
