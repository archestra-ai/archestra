import { describe, expect, test } from "@/test";
import ScheduleTriggerModel from "./schedule-trigger";

describe("ScheduleTriggerModel.findDueTriggers", () => {
  test("returns trigger when lastExecutedAt is in the past", async ({
    makeScheduleTrigger,
  }) => {
    const trigger = await makeScheduleTrigger({
      cronExpression: "* * * * *",
      enabled: true,
    });
    await ScheduleTriggerModel.markExecuted(
      trigger.id,
      new Date(Date.now() - 120_000),
    );

    const due = await ScheduleTriggerModel.findDueTriggers(new Date());

    expect(due.map((t) => t.id)).toContain(trigger.id);
  });

  test("does not return trigger when lastExecutedAt is recent", async ({
    makeScheduleTrigger,
  }) => {
    const trigger = await makeScheduleTrigger({
      cronExpression: "0 0 1 1 *", // once a year
      enabled: true,
    });
    await ScheduleTriggerModel.markExecuted(trigger.id, new Date());

    const due = await ScheduleTriggerModel.findDueTriggers(new Date());

    expect(due.map((t) => t.id)).not.toContain(trigger.id);
  });

  test("returns never-executed trigger when createdAt is old enough", async ({
    makeScheduleTrigger,
  }) => {
    // Trigger created with "* * * * *" cron and no lastExecutedAt —
    // its createdAt is "now" but the cron fires every minute,
    // so it should be due when checked 2 minutes later
    const trigger = await makeScheduleTrigger({
      cronExpression: "* * * * *",
      enabled: true,
    });

    const future = new Date(Date.now() + 120_000);
    const due = await ScheduleTriggerModel.findDueTriggers(future);

    expect(due.map((t) => t.id)).toContain(trigger.id);
  });

  test("does not return disabled triggers", async ({ makeScheduleTrigger }) => {
    const trigger = await makeScheduleTrigger({
      cronExpression: "* * * * *",
      enabled: false,
    });
    await ScheduleTriggerModel.markExecuted(
      trigger.id,
      new Date(Date.now() - 120_000),
    );

    const due = await ScheduleTriggerModel.findDueTriggers(new Date());

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
    const { schema } = await import("@/database");
    const { default: db } = await import("@/database");
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
