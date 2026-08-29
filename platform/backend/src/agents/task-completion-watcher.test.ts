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

import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import { describe, expect, test } from "@/test";
import type { AgentRunCompletionTarget } from "@/types";
import { watchTaskCompletion } from "./task-completion-watcher";

describe("watchTaskCompletion", () => {
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
        deploymentName: `runner-${task.id}`,
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
