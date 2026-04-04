import { describe, expect, test } from "@/test";
import AgentScheduleModel from "./agent-schedule";

describe("AgentScheduleModel", () => {
  test("can create an agent schedule", async ({ makeAgent }) => {
    const agent = await makeAgent();
    const schedule = await AgentScheduleModel.create({
      agentId: agent.id,
      cron: "0 0 * * *",
      payload: "Test payload",
      isActive: true,
      nextRunAt: new Date(),
    });

    expect(schedule).toBeDefined();
    expect(schedule.agentId).toBe(agent.id);
    expect(schedule.cron).toBe("0 0 * * *");
    expect(schedule.payload).toBe("Test payload");
  });

  test("can update an agent schedule", async ({ makeAgent }) => {
    const agent = await makeAgent();
    const schedule = await AgentScheduleModel.create({
      agentId: agent.id,
      cron: "0 0 * * *",
      isActive: true,
      nextRunAt: new Date(),
    });

    const updated = await AgentScheduleModel.update(schedule.id, {
      isActive: false,
      cron: "0 12 * * *",
    });

    expect(updated?.isActive).toBe(false);
    expect(updated?.cron).toBe("0 12 * * *");
  });

  test("can delete an agent schedule", async ({ makeAgent }) => {
    const agent = await makeAgent();
    const schedule = await AgentScheduleModel.create({
      agentId: agent.id,
      cron: "0 0 * * *",
      isActive: true,
      nextRunAt: new Date(),
    });

    await AgentScheduleModel.delete(schedule.id);
    const found = await AgentScheduleModel.findById(schedule.id);
    expect(found).toBeNull();
  });

  test("findById returns correct schedule", async ({ makeAgent }) => {
    const agent = await makeAgent();
    const schedule = await AgentScheduleModel.create({
      agentId: agent.id,
      cron: "0 0 * * *",
      isActive: true,
      nextRunAt: new Date(),
    });

    const found = await AgentScheduleModel.findById(schedule.id);
    expect(found?.id).toBe(schedule.id);
  });

  test("findAllByAgentId returns correct schedules", async ({ makeAgent }) => {
    const agent1 = await makeAgent();
    const agent2 = await makeAgent();

    const s1 = await AgentScheduleModel.create({
      agentId: agent1.id,
      cron: "0 0 * * *",
      isActive: true,
      nextRunAt: new Date(),
    });

    await AgentScheduleModel.create({
      agentId: agent2.id,
      cron: "0 0 * * *",
      isActive: true,
      nextRunAt: new Date(),
    });

    const schedules1 = await AgentScheduleModel.findAllByAgentId(agent1.id);
    expect(schedules1).toHaveLength(1);
    expect(schedules1[0].id).toBe(s1.id);
  });

  test("findAllDue returns only due and active schedules", async ({ makeAgent }) => {
    const agent = await makeAgent();
    const now = new Date();
    const past = new Date(now.getTime() - 10000);
    const future = new Date(now.getTime() + 10000);

    // Due and active
    const s1 = await AgentScheduleModel.create({
      agentId: agent.id,
      cron: "0 0 * * *",
      isActive: true,
      nextRunAt: past,
    });

    // Due but inactive
    await AgentScheduleModel.create({
      agentId: agent.id,
      cron: "0 0 * * *",
      isActive: false,
      nextRunAt: past,
    });

    // Active but not due
    await AgentScheduleModel.create({
      agentId: agent.id,
      cron: "0 0 * * *",
      isActive: true,
      nextRunAt: future,
    });

    const dueSchedules = await AgentScheduleModel.findAllDue();
    // Use filter in case there are other due schedules from other tests running in parallel (though usually tests use a fresh DB or transactions)
    const filteredDue = dueSchedules.filter(s => s.agentId === agent.id);
    
    expect(filteredDue).toHaveLength(1);
    expect(filteredDue[0].id).toBe(s1.id);
  });
});
