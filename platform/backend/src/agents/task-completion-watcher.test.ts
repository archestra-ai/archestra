import { vi } from "vitest";

const { notifyBindingThread, sendEmailReply } = vi.hoisted(() => ({
  notifyBindingThread: vi.fn(),
  sendEmailReply: vi.fn(),
}));

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: { notifyBindingThread },
}));

vi.mock("@/agents/incoming-email", () => ({
  getEmailProvider: () => ({
    providerId: "microsoft-graph",
    sendReply: sendEmailReply,
  }),
}));

import { CHATOPS_NO_REPLY_SENTINEL } from "@/agents/chatops/constants";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import { agentRuntimeFailureReason } from "@/services/agent-runtime/failure-reason";
import { describe, expect, test } from "@/test";
import type { AgentRunCompletionTarget } from "@/types";
import { watchTaskCompletion } from "./task-completion-watcher";

describe("watchTaskCompletion", () => {
  test("a UI continuation preserves Teams routing without reusing the prior turn's placeholder or mute marker", async ({
    makeAgent,
    makeUser,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent();
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const original = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_COMPLETED",
    });
    const continuation = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_COMPLETED",
    });
    const target = {
      type: "chatops" as const,
      bindingId: crypto.randomUUID(),
      threadId: "teams-thread",
      conversationReference: { conversation: { id: "teams-thread" } },
      originatingTaskId: original.id,
      placeholderActivityId: "thinking-message",
      muteMarkerAtStart: null,
    };
    await watchTaskCompletion({
      taskId: original.id,
      target,
      agentName: agent.name,
    });
    await watchTaskCompletion({
      taskId: continuation.id,
      target,
      agentName: agent.name,
    });
    expect(notifyBindingThread.mock.calls[0][0]).toMatchObject({
      placeholderActivityId: "thinking-message",
      muteMarkerAtStart: null,
    });
    expect(notifyBindingThread.mock.calls[1][0]).toEqual({
      taskId: continuation.id,
      bindingId: target.bindingId,
      threadId: target.threadId,
      conversationReference: target.conversationReference,
      agentName: agent.name,
      text: "Task finished.",
    });
  });

  test("delivers an image failure verbatim to its originating thread once", async ({
    makeAgent,
    makeUser,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent();
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const task = await A2ATaskModel.createForRun({
      contextId: context.id,
      agentId: agent.id,
    });
    const target = {
      type: "chatops" as const,
      bindingId: crypto.randomUUID(),
      threadId: "originating-thread",
    };
    await AgentRunModel.create({
      organizationId: agent.organizationId,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      workloadName: `runner-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      completionTarget: target,
    });
    const statusReason = agentRuntimeFailureReason(
      `75\n${JSON.stringify({
        version: 1,
        code: "custom_runtime.authentication_failed",
        message:
          "Authentication failed: your session has expired.\nReconnect your account and retry the task.",
      })}`,
    );
    await A2ATaskModel.transitionStateWithEvent({
      id: task.id,
      to: "TASK_STATE_FAILED",
      allowedFrom: ["TASK_STATE_SUBMITTED"],
      statusReason,
      eventPayload: {
        statusUpdate: {
          taskId: task.id,
          contextId: context.id,
          status: { state: "TASK_STATE_FAILED" },
        },
      },
    });

    const notification = { taskId: task.id, target, agentName: agent.name };
    await Promise.all([
      watchTaskCompletion(notification),
      watchTaskCompletion(notification),
    ]);
    await watchTaskCompletion(notification);

    expect(notifyBindingThread).toHaveBeenCalledExactlyOnceWith({
      taskId: task.id,
      bindingId: target.bindingId,
      threadId: target.threadId,
      agentName: agent.name,
      text: "Task failed. Authentication failed: your session has expired.\nReconnect your account and retry the task. (Runtime exit status 75.)",
    });
    expect(sendEmailReply).not.toHaveBeenCalled();
    expect(
      (await AgentRunModel.findByTaskId(task.id))?.completionNotifiedAt,
    ).toEqual(expect.any(Date));
  });

  test("delivers silent completion to the provider so it can clear its status", async ({
    makeAgent,
    makeUser,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent();
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const task = await A2ATaskModel.createForRun({
      contextId: context.id,
      agentId: agent.id,
    });
    const target = {
      type: "chatops" as const,
      bindingId: crypto.randomUUID(),
      threadId: "group-thread",
    };
    await AgentRunModel.create({
      organizationId: agent.organizationId,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      workloadName: `runner-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      completionTarget: target,
    });
    const silence = `This is addressed to someone else. ${CHATOPS_NO_REPLY_SENTINEL}`;
    await A2ATaskModel.completeRun({
      taskId: task.id,
      agentMessage: {
        id: crypto.randomUUID(),
        contextId: context.id,
        role: "ROLE_AGENT",
        parts: [{ text: silence }],
        content: {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: silence }],
        },
      },
      artifact: {
        id: crypto.randomUUID(),
        name: "agent-response",
        parts: [{ text: silence }],
      },
      eventPayloads: [],
    });

    await watchTaskCompletion({
      taskId: task.id,
      target,
      agentName: agent.name,
    });

    expect(notifyBindingThread).toHaveBeenCalledExactlyOnceWith({
      taskId: task.id,
      bindingId: target.bindingId,
      threadId: target.threadId,
      agentName: agent.name,
      text: silence,
    });
    expect(
      (await AgentRunModel.findByTaskId(task.id))?.completionNotifiedAt,
    ).toEqual(expect.any(Date));
  });

  test("delivers each durable completion once through its configured interface", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    for (const target of [
      {
        type: "chatops",
        bindingId: crypto.randomUUID(),
        threadId: "thread-1",
      },
      {
        type: "email",
        providerId: "microsoft-graph",
        originalMessageId: "message-1",
        fromAddress: "sender@example.com",
        toAddress: "agent@example.com",
        subject: "Background task",
      },
    ] satisfies AgentRunCompletionTarget[]) {
      const organization = await makeOrganization();
      const user = await makeUser();
      const agent = await makeAgent({
        organizationId: organization.id,
        name: "Background agent",
      });
      const context = await A2AContextModel.create({
        actorKind: "user",
        actorId: user.id,
      });
      const task = await A2ATaskModel.createForRun({
        contextId: context.id,
        agentId: agent.id,
      });
      await AgentRunModel.create({
        organizationId: organization.id,
        taskId: task.id,
        agentId: agent.id,
        actorKind: "user",
        actorId: user.id,
        actorUserId: user.id,
        workloadName: `runner-${task.id}`,
        backend: "kubernetes",
        runtimeScope: "archestra-dev",
        completionTarget: target,
      });

      await A2ATaskModel.completeRun({
        taskId: task.id,
        agentMessage: {
          id: crypto.randomUUID(),
          contextId: context.id,
          role: "ROLE_AGENT",
          parts: [{ text: "The work is complete." }],
          content: {
            id: crypto.randomUUID(),
            role: "assistant",
            parts: [{ type: "text", text: "The work is complete." }],
          },
        },
        artifact: {
          id: crypto.randomUUID(),
          name: "agent-response",
          parts: [{ text: "The work is complete." }],
        },
        eventPayloads: [],
      });

      await watchTaskCompletion({
        taskId: task.id,
        target,
        agentName: agent.name,
      });
      await watchTaskCompletion({
        taskId: task.id,
        target,
        agentName: agent.name,
      });

      if (target.type === "chatops") {
        expect(notifyBindingThread).toHaveBeenCalledTimes(1);
        expect(notifyBindingThread).toHaveBeenCalledWith({
          taskId: task.id,
          bindingId: target.bindingId,
          threadId: target.threadId,
          agentName: agent.name,
          text: "The work is complete.",
        });
      } else {
        expect(sendEmailReply).toHaveBeenCalledTimes(1);
        expect(sendEmailReply).toHaveBeenCalledWith({
          originalEmail: expect.objectContaining({
            messageId: target.originalMessageId,
            fromAddress: target.fromAddress,
            toAddress: target.toAddress,
            subject: target.subject,
          }),
          agentName: agent.name,
          body: "The work is complete.",
        });
      }
      expect(
        (await AgentRunModel.findByTaskId(task.id))?.completionNotifiedAt,
      ).toEqual(expect.any(Date));
    }
  });
});
