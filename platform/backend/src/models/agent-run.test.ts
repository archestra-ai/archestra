import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { describe, expect, test, vi } from "@/test";

test("runtime reconciliation owns stale workloads and recovers an ended run with an unsettled task", async ({
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
  const tasks = [];
  for (const ended of [false, true]) {
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
      lastHeartbeatAt: new Date(Date.now() - 3600_000),
    });
    const run = await AgentRunModel.create({
      organizationId: organization.id,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      workloadName: `runtime-recovery-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
    });
    if (ended)
      await AgentRunModel.close({
        id: run.id,
        logs: "Completed runtime output",
      });
    tasks.push(task);
  }
  expect(
    await A2ATaskModel.reapStaleRunning({
      staleMs: 600_000,
      statusReason: "orphaned server",
      buildEventPayload: (task) => ({
        statusUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          status: { state: "TASK_STATE_FAILED" },
        },
      }),
    }),
  ).toBe(0);
  for (const task of tasks) {
    expect((await A2ATaskModel.findById(task.id))?.state).toBe(
      "TASK_STATE_WORKING",
    );
  }
  expect((await AgentRunModel.listOpen()).map((run) => run.taskId)).toEqual(
    expect.arrayContaining(tasks.map((task) => task.id)),
  );
  await A2ATaskModel.updateState(tasks[1].id, "TASK_STATE_COMPLETED");
  expect(
    (await AgentRunModel.listOpen()).map((run) => run.taskId),
  ).not.toContain(tasks[1].id);
});

test("context continuation chooses the latest run without crossing owner or Agent boundaries", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const other = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const otherAgent = await makeAgent({ organizationId: org.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: owner.id,
  });
  const runs = [];
  for (const [index, actorId, agentId] of [
    [0, owner.id, agent.id],
    [1, owner.id, agent.id],
    [2, other.id, agent.id],
    [3, owner.id, otherAgent.id],
  ] as const) {
    const task = await A2ATaskModel.createForRun({
      contextId: context.id,
      agentId,
    });
    runs.push(
      await AgentRunModel.create({
        organizationId: org.id,
        taskId: task.id,
        agentId,
        actorKind: "user",
        actorId,
        actorUserId: actorId,
        workloadName: `workspace-${task.id}`,
        backend: "kubernetes",
        runtimeScope: "test",
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }),
    );
    // Drizzle collapses this all-null nested left join to null. A run whose
    // workspace was never created must fall back instead of throwing.
    expect(
      await AgentRunModel.findLatestInContext({
        contextId: context.id,
        agentId,
        organizationId: org.id,
        actorKind: "user",
        actorId,
      }),
    ).toBeNull();
    await AgentWorkspaceModel.create({
      organizationId: org.id,
      agentId,
      actorKind: "user",
      actorId,
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName: `workspace-${task.id}`,
      state: "idle",
      lastTaskId: task.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
  }
  const lookup = {
    contextId: context.id,
    agentId: agent.id,
    organizationId: org.id,
    actorKind: "user" as const,
    actorId: owner.id,
  };
  expect((await AgentRunModel.findLatestInContext(lookup))?.id).toBe(
    runs[1].id,
  );
  expect(
    await AgentRunModel.findLatestInContext({
      ...lookup,
      organizationId: crypto.randomUUID(),
    }),
  ).toBeNull();
  expect(
    await AgentRunModel.findLatestInContext({
      ...lookup,
      contextId: crypto.randomUUID(),
    }),
  ).toBeNull();
  const latest = await AgentWorkspaceModel.findByWorkloadName(
    runs[1].workloadName,
  );
  if (!latest) throw new Error("Expected retained workspace");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(latest.expiresAt.getTime() + 1));
    expect(await AgentRunModel.findLatestInContext(lookup)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
  await AgentWorkspaceModel.transition({
    id: latest.id,
    from: "idle",
    to: "deleted",
  });
  // The older retained workspace must not be resurrected as a fallback.
  expect(await AgentRunModel.findLatestInContext(lookup)).toBeNull();
});

describe("AgentRunModel completion notifications", () => {
  test("only one concurrent watcher can claim an execution's completion", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: organization.id });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const task = await A2ATaskModel.createForRun({
      contextId: context.id,
      agentId: agent.id,
    });
    const run = await AgentRunModel.create({
      organizationId: organization.id,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      workloadName: `runner-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      completionTarget: {
        type: "chatops",
        bindingId: crypto.randomUUID(),
        threadId: "thread-1",
      },
    });
    await A2ATaskModel.transitionStateWithEvent({
      id: task.id,
      to: "TASK_STATE_COMPLETED",
      allowedFrom: ["TASK_STATE_SUBMITTED"],
      eventPayload: {
        statusUpdate: {
          taskId: task.id,
          contextId: context.id,
          status: { state: "TASK_STATE_COMPLETED" },
          final: true,
        },
      },
    });
    await AgentRunModel.close({ id: run.id });

    expect(await AgentRunModel.listPendingCompletionNotifications()).toEqual([
      expect.objectContaining({ id: run.id }),
    ]);

    const claims = await Promise.all([
      AgentRunModel.claimCompletionNotification(task.id),
      AgentRunModel.claimCompletionNotification(task.id),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      (await AgentRunModel.findByTaskId(task.id))
        ?.completionNotificationClaimedAt,
    ).toEqual(expect.any(Date));

    await AgentRunModel.releaseCompletionNotification(run.id);
    expect(
      await AgentRunModel.claimCompletionNotification(task.id),
    ).not.toBeNull();

    await AgentRunModel.markCompletionNotified(run.id);
    await AgentRunModel.releaseCompletionNotification(run.id);
    expect(await AgentRunModel.claimCompletionNotification(task.id)).toBeNull();
    expect(await AgentRunModel.listPendingCompletionNotifications()).toEqual(
      [],
    );
  });
});

test("continuations keep one owner session and ordered history without exposing it to another user", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const other = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: owner.id,
  });
  const first = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  const workloadName = `session-${first.id}`;
  const common = {
    organizationId: org.id,
    agentId: agent.id,
    actorKind: "user" as const,
    actorId: owner.id,
    actorUserId: owner.id,
    workloadName,
    backend: "kubernetes" as const,
    runtimeScope: "test",
  };
  const firstRun = await AgentRunModel.create({ ...common, taskId: first.id });
  await AgentRunModel.close({ id: firstRun.id, logs: "first turn" });
  const workspace = await AgentWorkspaceModel.create({
    ...common,
    id: first.id,
    state: "idle",
    lastTaskId: first.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const second = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  const secondRun = await AgentRunModel.create({
    ...common,
    taskId: second.id,
  });
  expect(
    await AgentWorkspaceModel.claim({
      id: workspace.id,
      organizationId: org.id,
      actorKind: "user",
      actorId: owner.id,
      agentId: agent.id,
      taskId: second.id,
    }),
  ).not.toBeNull();
  const lookup = { actorUserId: owner.id, organizationId: org.id };
  for (const taskId of [first.id, second.id, workspace.id]) {
    expect(
      await AgentRunModel.findCurrentSessionForActor({ ...lookup, taskId }),
    ).toMatchObject({
      taskId: second.id,
      sessionId: first.id,
    });
    expect(
      await AgentRunModel.findCurrentSessionForActor({
        ...lookup,
        taskId,
        actorUserId: other.id,
      }),
    ).toBeNull();
  }
  const listed = await AgentRunModel.listForActor({
    ...lookup,
    pagination: { limit: 10, offset: 0 },
  });
  expect(listed.data.map((run) => run.taskId)).toEqual([second.id]);
  const history = await AgentRunModel.listPreviousTurns({ run: secondRun });
  expect(history.map((run) => run.id)).toEqual([firstRun.id]);
  expect(
    await AgentRunModel.listPreviousTurns({
      run: secondRun,
      afterId: firstRun.id,
    }),
  ).toEqual([]);
  // Explicit per-turn sharing must still resolve the requested record.
  expect(
    await AgentRunModel.findSessionByTaskId({
      taskId: first.id,
      organizationId: org.id,
    }),
  ).toMatchObject({ taskId: first.id });
});
