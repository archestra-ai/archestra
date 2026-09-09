import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import { describe, expect, test } from "@/test";

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
