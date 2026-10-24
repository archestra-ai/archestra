import client from "prom-client";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  ScheduleTriggerRunModel,
} from "@/models";
import AgentRuntimeHealthModel from "@/models/agent-runtime-health";
import { expect, test } from "@/test";
import { agentRuntimeHealthMetrics } from "./agent-runtime-health";

test("runtime health survives collector recreation, distinguishes agents and clears settled work", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: organization.id });
  const otherAgent = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const now = new Date();
  const old = new Date(now.getTime() - 600_000);
  const tasks = [];
  for (const [owner, state] of [
    [agent, "TASK_STATE_WORKING"],
    [otherAgent, "TASK_STATE_SUBMITTED"],
    [agent, "TASK_STATE_FAILED"],
  ] as const) {
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: owner.id,
      state,
      stateChangedAt: old,
      lastHeartbeatAt: old,
    });
    await AgentRunModel.create({
      organizationId: organization.id,
      taskId: task.id,
      agentId: owner.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      workloadName: `health-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
      attentionState: state === "TASK_STATE_WORKING" ? "auth_required" : null,
      completionTarget:
        state === "TASK_STATE_FAILED"
          ? {
              type: "chatops",
              bindingId: crypto.randomUUID(),
              threadId: "fixture-thread",
            }
          : null,
    });
    tasks.push(task);
  }
  const snapshot = await AgentRuntimeHealthModel.snapshot(now);
  expect(snapshot.find((row) => row.agentId === agent.id)).toMatchObject({
    working: 1,
    submitted: 0,
    authRequired: 1,
    failedRecent: 1,
    completionPending: 1,
    heartbeatAge: 600,
    completionAge: 600,
  });
  expect(snapshot.find((row) => row.agentId === otherAgent.id)).toMatchObject({
    working: 0,
    submitted: 1,
    authRequired: 0,
    failedRecent: 0,
    submittedAge: 600,
  });

  agentRuntimeHealthMetrics.initialize();
  const scrape = await client.register
    .getSingleMetric("agent_runtime_health_tasks")
    ?.get();
  expect(scrape?.values).toContainEqual(
    expect.objectContaining({
      labels: {
        agent_id: agent.id,
        backend: "kubernetes",
        condition: "auth_required",
      },
      value: 1,
    }),
  );
  expect(JSON.stringify(scrape)).not.toContain(tasks[0].id);

  await A2ATaskModel.updateState(tasks[0].id, "TASK_STATE_COMPLETED");
  const next = await client.register
    .getSingleMetric("agent_runtime_health_tasks")
    ?.get();
  expect(next?.values).toContainEqual(
    expect.objectContaining({
      labels: {
        agent_id: agent.id,
        backend: "kubernetes",
        condition: "auth_required",
      },
      value: 0,
    }),
  );
  // Older failures leave the rolling window, but an undelivered reply remains actionable.
  const later = await AgentRuntimeHealthModel.snapshot(
    new Date(now.getTime() + 3600_000),
  );
  expect(later.find((row) => row.agentId === agent.id)).toMatchObject({
    failedRecent: 0,
    completionPending: 1,
    heartbeatAge: 0,
    completionAge: 4200,
  });
});

test("counts failures before pod creation and paused authentication without blaming heartbeat", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const runtimeAgent = await makeAgent({
    organizationId: organization.id,
    runtime: {
      image: "example/runtime:latest",
      command: null,
      inferenceProtocol: "openai_responses",
      backend: "kubernetes",
      steerMode: "tmux_keys",
      privileged: false,
      resources: null,
      environment: null,
      credentials: null,
      ttlHours: null,
      idleTimeoutMinutes: null,
    },
  });
  const ordinaryAgent = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  for (const agent of [runtimeAgent, ordinaryAgent]) {
    await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_FAILED",
    });
  }
  await A2ATaskModel.create({
    contextId: context.id,
    agentId: runtimeAgent.id,
    state: "TASK_STATE_AUTH_REQUIRED",
    lastHeartbeatAt: new Date(0),
  });
  const rows = await AgentRuntimeHealthModel.snapshot();
  expect(rows.find((row) => row.agentId === runtimeAgent.id)).toMatchObject({
    failedRecent: 1,
    authRequired: 1,
    heartbeatAge: 0,
  });
  expect(rows.find((row) => row.agentId === ordinaryAgent.id)).toBeUndefined();
});

test("reports rejected scheduled launches without a runtime task, excluding overlap skips and duplicate failures", async ({
  makeOrganization,
  makeUser,
  makeAgent,
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({
    organizationId: organization.id,
    runtime: {
      image: "example/runtime:latest",
      backend: "kubernetes",
      command: null,
      inferenceProtocol: "openai_responses",
      steerMode: "pipe",
      privileged: false,
      resources: null,
      environment: null,
      credentials: null,
      ttlHours: null,
      idleTimeoutMinutes: null,
    },
  });
  const trigger = await makeScheduleTrigger({
    organizationId: organization.id,
    agentId: agent.id,
    actorUserId: user.id,
  });
  const rejected = await makeScheduleTriggerRun(trigger.id);
  await ScheduleTriggerRunModel.markCompleted({
    runId: rejected.id,
    status: "failed",
    error: "Runtime launch rejected",
  });
  expect(
    (await AgentRuntimeHealthModel.snapshot()).find(
      (row) => row.agentId === agent.id,
    ),
  ).toMatchObject({ failedRecent: 1, working: 0, submitted: 0 });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_FAILED",
  });
  const launched = await makeScheduleTriggerRun(trigger.id);
  await ScheduleTriggerRunModel.setRuntimeTaskId({
    runId: launched.id,
    taskId: task.id,
  });
  await ScheduleTriggerRunModel.markCompleted({
    runId: launched.id,
    status: "failed",
    error: "Runtime exited with failure",
  });
  const skipped = await ScheduleTriggerRunModel.recordDueRun({
    trigger,
    now: new Date(),
    skip: {
      error: "Skipped: previous work is unfinished",
      blockedBy: {
        phase: "running",
        runId: rejected.id,
        runtimeTaskId: null,
        startedAt: new Date().toISOString(),
        elapsedSeconds: 60,
        deadline: null,
        maximumDurationSeconds: null,
      },
    },
  });
  expect(skipped?.status).toBe("failed");
  const ordinaryAgent = await makeAgent({ organizationId: organization.id });
  const ordinaryTrigger = await makeScheduleTrigger({
    organizationId: organization.id,
    agentId: ordinaryAgent.id,
    actorUserId: user.id,
  });
  const ordinary = await makeScheduleTriggerRun(ordinaryTrigger.id);
  await ScheduleTriggerRunModel.markCompleted({
    runId: ordinary.id,
    status: "failed",
    error: "Foreground chat failed",
  });

  // One rejected launch and one failed task; the linked schedule is not counted twice.
  const now = new Date();
  const rows = await AgentRuntimeHealthModel.snapshot(now);
  expect(rows.find((row) => row.agentId === agent.id)).toMatchObject({
    failedRecent: 2,
    working: 0,
    submitted: 0,
  });
  expect(rows.find((row) => row.agentId === ordinaryAgent.id)).toBeUndefined();

  agentRuntimeHealthMetrics.initialize();
  const scrape = await client.register
    .getSingleMetric("agent_runtime_health_tasks")
    ?.get();
  expect(scrape?.values).toContainEqual(
    expect.objectContaining({
      labels: {
        agent_id: agent.id,
        backend: "kubernetes",
        condition: "failed_recent",
      },
      value: 2,
    }),
  );
  const later = await AgentRuntimeHealthModel.snapshot(
    new Date(now.getTime() + 16 * 60_000),
  );
  expect(later.find((row) => row.agentId === agent.id)).toBeUndefined();
});
