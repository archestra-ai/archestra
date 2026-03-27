import { describe, expect } from "vitest";
import { AgentScheduleTriggerModel } from "@/models";
import { test } from "@/test";

describe("AgentScheduleTriggerModel", () => {
  test("create and findById", async ({ makeInternalAgent }) => {
    const agent = await makeInternalAgent();

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Test Cron Trigger",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      message: "Daily check",
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(Date.now() + 60_000),
      intervalSeconds: undefined,
      scheduledAt: undefined,
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    expect(trigger.id).toBeDefined();
    expect(trigger.name).toBe("Test Cron Trigger");
    expect(trigger.triggerType).toBe("cron");
    expect(trigger.cronExpression).toBe("0 9 * * *");

    const found = await AgentScheduleTriggerModel.findById(trigger.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(trigger.id);
  });

  test("findByAgentId returns triggers for agent", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent();

    await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Trigger A",
      triggerType: "interval",
      intervalSeconds: 300,
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(Date.now() + 300_000),
      cronExpression: undefined,
      scheduledAt: undefined,
      message: "",
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Trigger B",
      triggerType: "cron",
      cronExpression: "*/5 * * * *",
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(Date.now() + 60_000),
      intervalSeconds: undefined,
      scheduledAt: undefined,
      message: "",
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    const triggers = await AgentScheduleTriggerModel.findByAgentId(agent.id);
    expect(triggers).toHaveLength(2);
  });

  test("findDueTriggers returns only enabled triggers past nextExecutionAt", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent();

    // Due trigger (past)
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
      intervalSeconds: undefined,
      scheduledAt: undefined,
      message: "",
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    // Future trigger (not due)
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
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    // Disabled trigger (due but disabled)
    await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Disabled Trigger",
      triggerType: "cron",
      cronExpression: "* * * * *",
      enabled: false,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(Date.now() - 60_000),
      intervalSeconds: undefined,
      scheduledAt: undefined,
      message: "",
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    const due = await AgentScheduleTriggerModel.findDueTriggers();
    expect(due).toHaveLength(1);
    expect(due[0].name).toBe("Due Trigger");
  });

  test("markExecuted updates execution state", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent();

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Exec Trigger",
      triggerType: "interval",
      intervalSeconds: 60,
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(),
      cronExpression: undefined,
      scheduledAt: undefined,
      message: "",
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    const nextExec = new Date(Date.now() + 60_000);
    await AgentScheduleTriggerModel.markExecuted({
      id: trigger.id,
      nextExecutionAt: nextExec,
    });

    const updated = await AgentScheduleTriggerModel.findById(trigger.id);
    expect(updated?.executionCount).toBe(1);
    expect(updated?.lastExecutedAt).not.toBeNull();
    expect(updated?.lastError).toBeNull();
  });

  test("markExecuted with null nextExecutionAt disables trigger", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent();

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "One-time Trigger",
      triggerType: "one_time",
      scheduledAt: new Date(),
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(),
      cronExpression: undefined,
      intervalSeconds: undefined,
      message: "",
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    await AgentScheduleTriggerModel.markExecuted({
      id: trigger.id,
      nextExecutionAt: null,
    });

    const updated = await AgentScheduleTriggerModel.findById(trigger.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.nextExecutionAt).toBeNull();
  });

  test("update modifies trigger fields", async ({ makeInternalAgent }) => {
    const agent = await makeInternalAgent();

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Original Name",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(Date.now() + 60_000),
      intervalSeconds: undefined,
      scheduledAt: undefined,
      message: "",
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    const updated = await AgentScheduleTriggerModel.update(trigger.id, {
      name: "Updated Name",
      cronExpression: "0 10 * * *",
    });

    expect(updated?.name).toBe("Updated Name");
    expect(updated?.cronExpression).toBe("0 10 * * *");
  });

  test("delete removes trigger", async ({ makeInternalAgent }) => {
    const agent = await makeInternalAgent();

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Delete Me",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(Date.now() + 60_000),
      intervalSeconds: undefined,
      scheduledAt: undefined,
      message: "",
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    const deleted = await AgentScheduleTriggerModel.delete(trigger.id);
    expect(deleted).toBe(true);

    const found = await AgentScheduleTriggerModel.findById(trigger.id);
    expect(found).toBeNull();
  });

  test("cascade delete when agent is deleted", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent();

    const trigger = await AgentScheduleTriggerModel.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      name: "Cascade Test",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      enabled: true,
      executionCount: 0,
      misfireGraceSeconds: 300,
      nextExecutionAt: new Date(Date.now() + 60_000),
      intervalSeconds: undefined,
      scheduledAt: undefined,
      message: "",
      lastExecutedAt: undefined,
      lastError: undefined,
    });

    // Import AgentModel to delete the agent
    const { AgentModel } = await import("@/models");
    await AgentModel.delete(agent.id);

    const found = await AgentScheduleTriggerModel.findById(trigger.id);
    expect(found).toBeNull();
  });
});
