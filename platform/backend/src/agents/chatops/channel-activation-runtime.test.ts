import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  ChatOpsChannelBindingModel,
} from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { AgentRunCompletionTarget } from "@/types/agent-runtime";
import {
  isChannelThreadActive,
  markChannelThreadActive,
  stopChannelThreadReply,
} from "./channel-activation";
import { chatOpsRunRegistry } from "./chatops-run-registry";

setupTestCacheManager();

test("Stop cancels durable turns without a local registration and isolates sibling bots, threads and providers", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: organization.id });
  const sibling = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const binding = await ChatOpsChannelBindingModel.create({
    organizationId: organization.id,
    agentId: agent.id,
    provider: "slack",
    channelId: "runtime-stop-channel",
  });
  const otherChannel = await ChatOpsChannelBindingModel.create({
    organizationId: organization.id,
    agentId: agent.id,
    provider: "slack",
    channelId: "other-channel",
  });
  const otherProvider = await ChatOpsChannelBindingModel.create({
    organizationId: organization.id,
    agentId: agent.id,
    provider: "ms-teams",
    channelId: binding.channelId,
  });
  const target = {
    type: "chatops",
    bindingId: binding.id,
    threadId: "runtime-stop-thread",
    pinnedAgentId: agent.id,
  } as const;
  const createTurn = async (
    completionTarget: AgentRunCompletionTarget,
    completed = false,
  ) => {
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: completed ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING",
    });
    await AgentRunModel.create({
      organizationId: organization.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      taskId: task.id,
      workloadName: `stop-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
      completionTarget,
    });
    return task;
  };
  const active = await createTurn(target);
  const completed = await createTurn(target, true);
  const router = await createTurn({
    type: "chatops",
    bindingId: binding.id,
    threadId: target.threadId,
  });
  const untouched = await Promise.all([
    createTurn({ ...target, pinnedAgentId: sibling.id }),
    createTurn({ ...target, threadId: "other-thread" }),
    createTurn({ ...target, bindingId: otherChannel.id }),
    createTurn({ ...target, bindingId: otherProvider.id }),
  ]);
  const thread = {
    provider: "slack",
    channelId: binding.channelId,
    threadId: target.threadId,
    scope: `agent:${agent.id}`,
  } as const;
  await markChannelThreadActive(thread);
  const foreground = chatOpsRunRegistry.register(thread);
  try {
    await stopChannelThreadReply(thread);
    expect((await A2ATaskModel.findById(active.id))?.state).toBe(
      "TASK_STATE_CANCELED",
    );
    expect(foreground.signal.aborted).toBe(true);
    expect(await isChannelThreadActive(thread)).toBe(true);
    expect((await A2ATaskModel.findById(router.id))?.state).toBe(
      "TASK_STATE_WORKING",
    );
    expect((await A2ATaskModel.findById(completed.id))?.state).toBe(
      "TASK_STATE_COMPLETED",
    );
    // Redelivery does not recancel terminal tasks or affect another bot.
    await stopChannelThreadReply(thread);
    await stopChannelThreadReply({ ...thread, scope: undefined });
    expect((await A2ATaskModel.findById(router.id))?.state).toBe(
      "TASK_STATE_CANCELED",
    );
    for (const task of untouched) {
      expect((await A2ATaskModel.findById(task.id))?.state).toBe(
        "TASK_STATE_WORKING",
      );
    }
  } finally {
    foreground.unregister();
  }
});
