import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import { describe, expect, test } from "@/test";

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
      deploymentName: `runner-${task.id}`,
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
