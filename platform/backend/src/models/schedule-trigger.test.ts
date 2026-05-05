import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import ScheduleTriggerModel from "./schedule-trigger";

describe("ScheduleTriggerModel.findDueTriggers", () => {
  test("returns trigger when lastExecutedAt is in the past", async ({
    makeScheduleTrigger,
  }) => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    const trigger = await makeScheduleTrigger({
      cronExpression: "0 * * * *",
      enabled: true,
    });
    await ScheduleTriggerModel.markExecuted(
      trigger.id,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    const due = await ScheduleTriggerModel.findDueTriggers(now);

    expect(due.map((t) => t.id)).toContain(trigger.id);
  });

  test("does not return trigger when lastExecutedAt is recent", async ({
    makeScheduleTrigger,
  }) => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    const trigger = await makeScheduleTrigger({
      cronExpression: "0 * * * *",
      enabled: true,
    });
    await ScheduleTriggerModel.markExecuted(
      trigger.id,
      new Date("2026-01-01T01:00:00.000Z"),
    );

    const due = await ScheduleTriggerModel.findDueTriggers(now);

    expect(due.map((t) => t.id)).not.toContain(trigger.id);
  });

  test("returns never-executed trigger when createdAt is old enough", async ({
    makeScheduleTrigger,
  }) => {
    const createdAt = new Date("2026-01-01T01:00:00.000Z");
    const future = new Date("2026-01-01T03:00:00.000Z");

    const trigger = await makeScheduleTrigger({
      name: "Never-executed trigger",
      messageTemplate: "test",
      cronExpression: "0 * * * *",
      createdAt,
    });

    const due = await ScheduleTriggerModel.findDueTriggers(future);

    expect(due.map((t) => t.id)).toContain(trigger.id);
  });

  test("does not return disabled triggers", async ({ makeScheduleTrigger }) => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    const trigger = await makeScheduleTrigger({
      cronExpression: "0 * * * *",
      enabled: false,
    });
    await ScheduleTriggerModel.markExecuted(
      trigger.id,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    const due = await ScheduleTriggerModel.findDueTriggers(now);

    expect(due.map((t) => t.id)).not.toContain(trigger.id);
  });

  test("skips triggers with invalid cron expressions without crashing", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });

    // Insert directly to bypass validation
    await db.insert(schema.scheduleTriggersTable).values({
      organizationId: org.id,
      name: "Bad Cron Trigger",
      agentId: agent.id,
      messageTemplate: "test",
      cronExpression: "INVALID",
      timezone: "UTC",
      enabled: true,
      actorUserId: user.id,
    });

    // Should not throw
    const due = await ScheduleTriggerModel.findDueTriggers(new Date());
    expect(due.every((t) => t.cronExpression !== "INVALID")).toBe(true);
  });
});
