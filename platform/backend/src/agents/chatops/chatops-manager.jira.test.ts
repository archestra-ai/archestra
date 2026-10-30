import { randomUUID } from "node:crypto";
import { vi } from "vitest";

vi.mock("@/cache-manager");

import { A2AManager } from "@/agents/a2a/a2a-manager";
import { A2AProtocolRole } from "@/agents/a2a/a2a-protocol";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import {
  A2AContextModel,
  A2ATaskApprovalRequestModel,
  A2ATaskModel,
  ChatOpsChannelBindingModel,
  UserModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { IncomingChatMessage } from "@/types";
import type { JiraBotConfig, JiraDbConfig } from "@/types/chatops-jira";
import { ChatOpsManager } from "./chatops-manager";
import JiraProvider, { jiraChannelId } from "./jira-provider";

beforeEach(() => {
  vi.spyOn(A2AManager.prototype, "sendMessage").mockResolvedValue({
    message: {
      messageId: randomUUID(),
      role: A2AProtocolRole.Agent,
      parts: [{ text: "Synthetic answer" }],
    },
  });
});

describe("Jira requester and approval identity", () => {
  for (const actorKind of ["user", "serviceAccount"] as const) {
    for (const approved of [true, false]) {
      test(`a verified reviewer ${approved ? "approves" : "declines"} a ${actorKind} task through the actual decision handler`, async ({
        makeOrganization,
        makeUser,
        makeMember,
        makeInternalAgent,
        makeServiceAccount,
      }) => {
        const org = await makeOrganization();
        const reviewer = await makeUser({ emailVerified: true });
        await makeMember(reviewer.id, org.id);
        const agent = await makeInternalAgent({ organizationId: org.id });
        const service = await makeServiceAccount(org.id);
        const { provider, message, manager } = await fixture(org.id, agent.id, {
          fallbackServiceAccountId: service.id,
          fallbackReviewerUserId: reviewer.id,
        });
        const actorId = actorKind === "user" ? reviewer.id : service.id;
        const context = await A2AContextModel.create({ actorKind, actorId });
        const task = await A2ATaskModel.create({
          contextId: context.id,
          agentId: agent.id,
          state: "TASK_STATE_INPUT_REQUIRED",
        });
        await A2ATaskApprovalRequestModel.bulkCreate({
          taskId: task.id,
          approvalRequests: [
            {
              approvalId: "approval-decision",
              toolCallId: "call-decision",
              toolName: "synthetic_tool",
              approved: false,
              resolved: false,
            },
          ],
        });
        await A2ATaskApprovalRequestModel.attachChatReviewer({
          taskId: task.id,
          approvalId: "approval-decision",
          userId: reviewer.id,
          channelId: message.channelId,
          threadId: message.threadId,
        });
        const update = vi
          .spyOn(provider, "updateApprovalRequest")
          .mockResolvedValue();
        message.senderEmail = reviewer.email;
        message.text = approved ? "approve" : "decline";

        expect(
          (await manager.processJiraMessage(provider, message)).success,
        ).toBe(true);
        expect(update).toHaveBeenCalledWith(
          expect.objectContaining({
            approved,
            messageKey: "approval-decision",
          }),
        );
        expect(
          A2AManager.prototype.sendMessage,
        ).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            actor: { kind: actorKind, id: actorId, organizationId: org.id },
            agentId: agent.id,
            request: expect.objectContaining({
              message: expect.objectContaining({
                metadata: expect.objectContaining({
                  taskOps: {
                    approvalDecisions: [
                      { approvalId: "approval-decision", approved },
                    ],
                  },
                }),
              }),
            }),
          }),
        );
      });
    }
  }

  test("an unverified reviewer cannot activate hidden-email service fallback or approve a task", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const reviewer = await makeUser({ emailVerified: false });
    await makeMember(reviewer.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const service = await makeServiceAccount(org.id);
    const { provider, message, manager } = await fixture(org.id, agent.id, {
      fallbackServiceAccountId: service.id,
      fallbackReviewerUserId: reviewer.id,
    });
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      false,
    );
    message.senderEmail = reviewer.email;
    message.text = "approve";
    expect(await manager.processJiraMessage(provider, message)).toMatchObject({
      success: false,
      error: "A verified authorized human must approve this request",
    });
    expect(A2AManager.prototype.sendMessage).not.toHaveBeenCalled();
  });

  test("hidden email uses the opted-in service actor with requester provenance", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const reviewer = await makeUser();
    await makeMember(reviewer.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const service = await makeServiceAccount(org.id);
    const { provider, message, manager } = await fixture(org.id, agent.id, {
      fallbackServiceAccountId: service.id,
      fallbackReviewerUserId: reviewer.id,
    });
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      true,
    );
    expect(provider.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("archestra-mute"),
      }),
    );
    expect(vi.mocked(provider.sendReply).mock.calls[0][0].hint).not.toContain(
      "react",
    );
    const invocation = vi.mocked(A2AManager.prototype.sendMessage).mock
      .calls[0][0];
    expect(invocation.actor).toEqual({
      kind: "serviceAccount",
      id: service.id,
      organizationId: org.id,
    });
    expect(JSON.stringify(invocation.request)).toContain(
      "Jira requester accountId requester-account",
    );
    expect(JSON.stringify(invocation.request)).toContain(
      "not a verified human Archestra identity",
    );
  });

  test("a known human denied agent access never falls back to the service actor", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const reviewer = await makeUser();
    const requester = await makeUser();
    await makeMember(reviewer.id, org.id);
    await makeMember(requester.id, org.id);
    const agent = await makeInternalAgent({
      organizationId: org.id,
      authorId: reviewer.id,
      access: "personal",
    });
    const service = await makeServiceAccount(org.id);
    const { provider, message, manager } = await fixture(org.id, agent.id, {
      fallbackServiceAccountId: service.id,
      fallbackReviewerUserId: reviewer.id,
    });
    message.senderEmail = requester.email;
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      false,
    );
    expect(A2AManager.prototype.sendMessage).not.toHaveBeenCalled();
  });

  test("an observed human remains linked when Jira later hides their email", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const requester = await makeUser();
    const reviewer = await makeUser();
    await makeMember(requester.id, org.id);
    await makeMember(reviewer.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const service = await makeServiceAccount(org.id);
    const { provider, message, manager } = await fixture(org.id, agent.id, {
      fallbackServiceAccountId: service.id,
      fallbackReviewerUserId: reviewer.id,
    });
    message.senderEmail = requester.email;
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      true,
    );
    message.senderEmail = undefined;
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      true,
    );
    expect(
      vi.mocked(A2AManager.prototype.sendMessage).mock.calls[1][0].actor,
    ).toEqual({ kind: "user", id: requester.id, organizationId: org.id });
    await UserModel.patch(requester.id, { banned: true });
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      false,
    );
    expect(A2AManager.prototype.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("disabled service identity is rejected at invocation even after setup", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const reviewer = await makeUser();
    await makeMember(reviewer.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const service = await makeServiceAccount(org.id, { disabled: true });
    const { provider, message, manager } = await fixture(org.id, agent.id, {
      fallbackServiceAccountId: service.id,
      fallbackReviewerUserId: reviewer.id,
    });
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      false,
    );
    expect(A2AManager.prototype.sendMessage).not.toHaveBeenCalled();
    expect(serviceAccountUserId(service.id)).not.toBe(reviewer.id);
  });

  test("approval replies bind a verified reviewer to one stored issue and task", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const reviewer = await makeUser();
    const other = await makeUser();
    await makeMember(reviewer.id, org.id);
    await makeMember(other.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { provider, message, manager } = await fixture(org.id, agent.id);
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: reviewer.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_INPUT_REQUIRED",
    });
    await A2ATaskApprovalRequestModel.bulkCreate({
      taskId: task.id,
      approvalRequests: [
        {
          approvalId: "approval-example",
          toolCallId: "call-example",
          toolName: "synthetic_tool",
          approved: false,
          resolved: false,
        },
      ],
    });
    await A2ATaskApprovalRequestModel.attachChatReviewer({
      taskId: task.id,
      approvalId: "approval-example",
      userId: reviewer.id,
      channelId: message.channelId,
      threadId: message.threadId,
    });
    const decide = vi
      .spyOn(manager, "handleInteractiveApprovalDecision")
      .mockResolvedValue();
    message.text = "approve";
    message.senderEmail = other.email;
    message.senderId = "other-reviewer-account";
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      false,
    );
    expect(decide).not.toHaveBeenCalled();
    message.senderEmail = reviewer.email;
    message.senderId = "designated-reviewer-account";
    message.threadId = "20001";
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      false,
    );
    message.threadId = "20000";
    expect((await manager.processJiraMessage(provider, message)).success).toBe(
      true,
    );
    expect(decide).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        taskId: task.id,
        approvalId: "approval-example",
        messageTs: "approval-example",
        userId: message.senderId,
      }),
    );
  });
});

async function fixture(
  organizationId: string,
  agentId: string,
  extras: Partial<JiraBotConfig> = {},
) {
  const bot: JiraBotConfig = {
    id: randomUUID(),
    agentId,
    accountId: "bot-account",
    displayName: "Example Bot",
    email: "bot@example.test",
    apiToken: "synthetic-only-token",
    enabled: true,
    ...extras,
  };
  const config: JiraDbConfig = {
    id: randomUUID(),
    organizationId,
    siteUrl: "https://example.atlassian.net",
    enabled: true,
    ingressMode: "hmac",
    webhookSecret: "synthetic-webhook-secret",
    bots: [bot],
  };
  const provider = new JiraProvider(config, bot);
  vi.spyOn(provider, "getUserEmail").mockResolvedValue(null);
  vi.spyOn(provider, "sendReply").mockResolvedValue("30000");
  vi.spyOn(provider, "getThreadHistory").mockResolvedValue([]);
  vi.spyOn(provider, "setTypingStatus").mockResolvedValue();
  vi.spyOn(provider, "clearTypingStatus").mockResolvedValue();
  await ChatOpsChannelBindingModel.create({
    organizationId,
    provider: "jira",
    channelId: jiraChannelId(bot.id, "10000"),
    workspaceId: config.id,
    agentId,
    channelInstructions: "Always state the next concrete step.",
  });
  const message: IncomingChatMessage = {
    messageId: `jira:${config.id}:${bot.id}:30000:revision`,
    channelId: jiraChannelId(bot.id, "10000"),
    workspaceId: config.id,
    threadId: "20000",
    senderId: "requester-account",
    senderName: "Example Requester",
    text: "Explain this issue",
    rawText: "Explain this issue",
    timestamp: new Date(),
    isThreadReply: true,
    metadata: {
      jiraEventId: `event:${randomUUID()}`,
      jiraRequesterAccountId: "requester-account",
      botMentioned: true,
      conversationType: "channel",
    },
  };
  return { provider, message, manager: new ChatOpsManager() };
}
