import { randomUUID } from "node:crypto";
import { type AgentRuntimeState, agentRuntimeError } from "@archestra/shared";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import { expect, test } from "@/test";

test("runtime diagnostics reject replay, another attempt, and updates after task settlement", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const owner = await makeUser();
  const agent = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: owner.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  await AgentRunModel.create({
    organizationId: organization.id,
    taskId: task.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: owner.id,
    actorUserId: owner.id,
    workloadName: `events-${task.id}`,
    backend: "kubernetes",
    runtimeScope: "test",
  });
  const state: AgentRuntimeState = {
    version: 1,
    attemptId: randomUUID(),
    sequence: 2,
    eventId: randomUUID(),
    source: "codex",
    observedAt: new Date().toISOString(),
    activity: "idle",
    outcome: null,
    diagnostic: agentRuntimeError("codex_auth_required"),
  };
  const update = (value: AgentRuntimeState) =>
    AgentRunModel.updateRuntimeState({
      taskId: task.id,
      state: value,
      attentionState: value.diagnostic ? "auth_required" : null,
    });
  expect(await update(state)).toBe(true);
  expect(await update({ ...state, sequence: 1, diagnostic: null })).toBe(false);
  expect(await update(state)).toBe(false);
  expect(await update({ ...state, attemptId: randomUUID(), sequence: 3 })).toBe(
    false,
  );
  expect(
    (await AgentRunModel.findByTaskId(task.id))?.runtimeState?.diagnostic?.code,
  ).toBe("codex_auth_required");
  expect(
    await update({
      ...state,
      sequence: 3,
      diagnostic: null,
      activity: "working",
    }),
  ).toBe(true);
  await A2ATaskModel.updateState(task.id, "TASK_STATE_COMPLETED");
  expect(await update({ ...state, sequence: 4 })).toBe(false);
  expect(
    (await AgentRunModel.findByTaskId(task.id))?.attentionState,
  ).toBeNull();
});
