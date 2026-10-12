import { vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import { A2AProtocolTaskState } from "@/agents/a2a/a2a-protocol";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import {
  A2AContextModel,
  A2ATaskApprovalRequestModel,
  A2ATaskModel,
  ChatOpsChannelBindingModel,
} from "@/models";
import { attachHitlReviews } from "@/openappa/a2a-hitl-review";
import * as openappaService from "@/openappa/service";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { ChatOpsApprovalDecision, ChatOpsProvider } from "@/types";
import { ChatOpsManager } from "./chatops-manager";

setupTestCacheManager();

const CHANNEL = "C123";
const THREAD = "1700000000.000100";
const SESSION_ID = `chatops:slack:${CHANNEL}:${THREAD}`;

function slackProvider(emails: Record<string, string>) {
  const provider = {
    providerId: "slack",
    displayName: "Slack",
    isConfigured: () => true,
    initialize: async () => {},
    cleanup: async () => {},
    validateWebhookRequest: async () => true,
    handleValidationChallenge: () => null,
    parseWebhookNotification: async () => null,
    sendReply: async () => "reply-id",
    parseInteractivePayload: () => null,
    sendAgentSelectionCard: async () => {},
    getThreadHistory: async () => [],
    getUserEmail: async (slackUserId: string) => emails[slackUserId] ?? null,
    getChannelName: async () => null,
    getWorkspaceId: () => null,
    getWorkspaceName: () => null,
    hasMissingScopes: () => false,
    notifyMissingScopes: async () => {},
    downloadFiles: async () => [],
    discoverChannels: async () => null,
    addApprovalRequestForm: vi.fn(async () => {}),
    updateApprovalRequest: vi.fn(async () => {}),
    sendEphemeralMessage: vi.fn(async () => {}),
  } satisfies ChatOpsProvider;
  return provider;
}

async function setup({
  makeUser,
  makeOrganization,
  makeInternalAgent,
}: {
  makeUser: (o?: { email?: string }) => Promise<{ id: string; email: string }>;
  makeOrganization: () => Promise<{ id: string }>;
  makeInternalAgent: (o: { organizationId: string }) => Promise<{ id: string }>;
}) {
  const reviewer = await makeUser({ email: "reviewer@example.com" });
  await makeUser({ email: "bystander@example.com" });
  const org = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id });
  await ChatOpsChannelBindingModel.create({
    organizationId: org.id,
    provider: "slack",
    channelId: CHANNEL,
    workspaceId: "T1",
    agentId: agent.id,
  });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: reviewer.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    state: A2AProtocolTaskState.InputRequired,
  });
  const approvalRequests = [
    {
      approvalId: "approval-1",
      toolCallId: "call-1",
      toolName: archestraMcpBranding.getToolName("execute_remedy_plan"),
      toolInput: {
        offer_id: "offer-1",
        trajectory: { v: 1, session_id: SESSION_ID },
      },
      approved: false,
      resolved: false,
    },
  ];
  await A2ATaskApprovalRequestModel.bulkCreate({
    taskId: task.id,
    approvalRequests,
  });
  vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
    offer_id: "offer-1",
    text: "Approve this call?",
    session_id: SESSION_ID,
  });
  await attachHitlReviews({
    organizationId: org.id,
    taskId: task.id,
    approvalRequests,
    answerer: {
      kind: "slack",
      reviewerUserId: reviewer.id,
      channelId: CHANNEL,
      threadTs: THREAD,
    },
    now: new Date(),
  });
  const decision = (
    slackUserId: string,
    approved: boolean,
  ): ChatOpsApprovalDecision => ({
    taskId: task.id,
    approvalId: "approval-1",
    approved,
    toolName: "execute_remedy_plan",
    messageTs: "msg-ts",
    channelId: CHANNEL,
    workspaceId: "T1",
    threadTs: THREAD,
    userId: slackUserId,
    userName: slackUserId,
    responseUrl: "",
    originalMessage: {
      messageId: "m1",
      channelId: CHANNEL,
      workspaceId: "T1",
      threadId: THREAD,
      senderId: "U_REVIEWER",
      senderEmail: "reviewer@example.com",
      senderName: "Reviewer",
      text: "",
      rawText: "",
      timestamp: new Date(),
      isThreadReply: true,
    },
  });
  return { decision };
}

test("only the reviewer's Slack click decides the OpenAPPA review", async ({
  makeUser,
  makeOrganization,
  makeInternalAgent,
}) => {
  const resume = vi
    .spyOn(A2AManager.prototype, "sendMessage")
    .mockResolvedValue({});
  const { decision } = await setup({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  });
  const provider = slackProvider({
    U_REVIEWER: "reviewer@example.com",
    U_BYSTANDER: "bystander@example.com",
  });
  const manager = new ChatOpsManager();

  try {
    await manager.handleInteractiveApprovalDecision(
      provider,
      decision("U_BYSTANDER", true),
    );
    expect(resume).not.toHaveBeenCalled();
    expect(provider.updateApprovalRequest).not.toHaveBeenCalled();
    expect(provider.sendEphemeralMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "U_BYSTANDER",
        text: "Only the person who asked for this action can approve or decline it.",
      }),
    );

    // A decline still resumes the run: `execute_remedy_plan` hands the deny
    // ruling to OpenAPPA, which closes the offer.
    await manager.handleInteractiveApprovalDecision(
      provider,
      decision("U_REVIEWER", false),
    );
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0][0].request.message.metadata).toMatchObject({
      taskOps: {
        approvalDecisions: [{ approvalId: "approval-1", approved: true }],
      },
    });
    expect(provider.updateApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        approved: false,
        decidedByUserId: "U_REVIEWER",
      }),
    );

    // The buttons may still be on screen for a moment: a second click is
    // refused and does not resume the run again.
    await manager.handleInteractiveApprovalDecision(
      provider,
      decision("U_REVIEWER", true),
    );
    expect(resume).toHaveBeenCalledTimes(1);
    expect(provider.sendEphemeralMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "This review was already declined." }),
    );
  } finally {
    resume.mockRestore();
  }
});
