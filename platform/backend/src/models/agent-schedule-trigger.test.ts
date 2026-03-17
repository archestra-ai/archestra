import { describe, expect, test } from "@/test";
import AgentScheduleTriggerModel from "./agent-schedule-trigger";

describe("AgentScheduleTriggerModel", () => {
  test("creates and retrieves a cron trigger", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "trigger-test@test.com" });
    const agent = await makeAgent(org.id, { agentType: "agent" });

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "Daily Morning Report",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Generate the daily morning report",
      enabled: true,
      misfireGraceSeconds: 60,
      createdBy: user.id,
    });

    expect(trigger).toBeDefined();
    expect(trigger.name).toBe("Daily Morning Report");
    expect(trigger.triggerType).toBe("cron");
    expect(trigger.cronExpression).toBe("0 9 * * *");
    expect(trigger.enabled).toBe(true);
    expect(trigger.executionCount).toBe(0);

    const found = await AgentScheduleTriggerModel.findById(trigger.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(trigger.id);
  });

  test("creates an interval trigger", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "interval-test@test.com" });
    const agent = await makeAgent(org.id, { agentType: "agent" });

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "Hourly Check",
      triggerType: "interval",
      cronExpression: null,
      intervalSeconds: 3600,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Check system status",
      enabled: true,
      misfireGraceSeconds: 30,
      createdBy: user.id,
    });

    expect(trigger.triggerType).toBe("interval");
    expect(trigger.intervalSeconds).toBe(3600);
  });

  test("creates a once trigger", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "once-test@test.com" });
    const agent = await makeAgent(org.id, { agentType: "agent" });

    const futureDate = new Date(Date.now() + 86400000);

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "One-time Task",
      triggerType: "once",
      cronExpression: null,
      intervalSeconds: null,
      executeAt: futureDate,
      timezone: "America/New_York",
      inputMessage: "Run the one-time migration task",
      enabled: true,
      misfireGraceSeconds: 120,
      createdBy: user.id,
    });

    expect(trigger.triggerType).toBe("once");
    expect(trigger.executeAt).toBeDefined();
    expect(trigger.timezone).toBe("America/New_York");
  });

  test("finds triggers by agent ID", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "find-agent-test@test.com" });
    const agent = await makeAgent(org.id, { agentType: "agent" });

    await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "Trigger A",
      triggerType: "cron",
      cronExpression: "*/5 * * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Task A",
      enabled: true,
      misfireGraceSeconds: 60,
      createdBy: user.id,
    });

    await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "Trigger B",
      triggerType: "interval",
      cronExpression: null,
      intervalSeconds: 1800,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Task B",
      enabled: true,
      misfireGraceSeconds: 60,
      createdBy: user.id,
    });

    const triggers = await AgentScheduleTriggerModel.findByAgentId({
      agentId: agent.id,
      organizationId: org.id,
    });

    expect(triggers.length).toBe(2);
  });

  test("updates a trigger", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "update-test@test.com" });
    const agent = await makeAgent(org.id, { agentType: "agent" });

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "Original Name",
      triggerType: "cron",
      cronExpression: "0 * * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Original message",
      enabled: true,
      misfireGraceSeconds: 60,
      createdBy: user.id,
    });

    const updated = await AgentScheduleTriggerModel.update({
      id: trigger.id,
      organizationId: org.id,
      data: {
        name: "Updated Name",
        cronExpression: "*/30 * * * *",
        inputMessage: "Updated message",
      },
    });

    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Updated Name");
    expect(updated!.cronExpression).toBe("*/30 * * * *");
    expect(updated!.inputMessage).toBe("Updated message");
  });

  test("deletes a trigger", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "delete-test@test.com" });
    const agent = await makeAgent(org.id, { agentType: "agent" });

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "To Delete",
      triggerType: "cron",
      cronExpression: "0 0 * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Delete me",
      enabled: true,
      misfireGraceSeconds: 60,
      createdBy: user.id,
    });

    const deleted = await AgentScheduleTriggerModel.delete({
      id: trigger.id,
      organizationId: org.id,
    });
    expect(deleted).toBe(true);

    const found = await AgentScheduleTriggerModel.findById(trigger.id);
    expect(found).toBeUndefined();
  });

  test("enables and disables a trigger", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "enable-test@test.com" });
    const agent = await makeAgent(org.id, { agentType: "agent" });

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "Toggle Test",
      triggerType: "cron",
      cronExpression: "0 0 * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Toggle me",
      enabled: true,
      misfireGraceSeconds: 60,
      createdBy: user.id,
    });

    const disabled = await AgentScheduleTriggerModel.setEnabled({
      id: trigger.id,
      organizationId: org.id,
      enabled: false,
    });
    expect(disabled!.enabled).toBe(false);

    const enabled = await AgentScheduleTriggerModel.setEnabled({
      id: trigger.id,
      organizationId: org.id,
      enabled: true,
    });
    expect(enabled!.enabled).toBe(true);
  });

  test("updates execution tracking", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "execution-test@test.com" });
    const agent = await makeAgent(org.id, { agentType: "agent" });

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "Execution Tracking",
      triggerType: "cron",
      cronExpression: "0 0 * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Track me",
      enabled: true,
      misfireGraceSeconds: 60,
      createdBy: user.id,
    });

    const now = new Date();
    const nextRun = new Date(Date.now() + 86400000);

    await AgentScheduleTriggerModel.updateExecution({
      id: trigger.id,
      lastExecutedAt: now,
      nextExecuteAt: nextRun,
      lastStatus: "success",
      lastError: null,
    });

    const updated = await AgentScheduleTriggerModel.findById(trigger.id);
    expect(updated!.executionCount).toBe(1);
    expect(updated!.lastStatus).toBe("success");
    expect(updated!.lastError).toBeNull();
    expect(updated!.lastExecutedAt).toBeDefined();
  });

  test("finds all enabled triggers", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "enabled-test@test.com" });
    const agent = await makeAgent(org.id, { agentType: "agent" });

    await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "Enabled Trigger",
      triggerType: "cron",
      cronExpression: "0 0 * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Enabled",
      enabled: true,
      misfireGraceSeconds: 60,
      createdBy: user.id,
    });

    await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: org.id,
      name: "Disabled Trigger",
      triggerType: "cron",
      cronExpression: "0 12 * * *",
      intervalSeconds: null,
      executeAt: null,
      timezone: "UTC",
      inputMessage: "Disabled",
      enabled: false,
      misfireGraceSeconds: 60,
      createdBy: user.id,
    });

    const enabled = await AgentScheduleTriggerModel.findAllEnabled();
    const ourTriggers = enabled.filter((t) => t.agentId === agent.id);
    expect(ourTriggers.length).toBe(1);
    expect(ourTriggers[0].name).toBe("Enabled Trigger");
  });
});
