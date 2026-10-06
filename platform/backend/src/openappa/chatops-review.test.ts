import crypto from "node:crypto";
import { TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME } from "@archestra/shared";
import type { UIMessage } from "ai";
import { vi } from "vitest";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import {
  A2AContextManager,
  A2ATaskManager,
} from "@/agents/a2a/a2a-model-manager";
import {
  A2AProtocolRole,
  A2AProtocolTaskState,
} from "@/agents/a2a/a2a-protocol";
import config from "@/config";
import {
  A2ATaskApprovalRequestModel,
  A2ATaskModel,
  MemberModel,
} from "@/models";
import { consumeHitlRuling, stageHitlReview } from "@/openappa/hitl-review";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import * as openappaService from "@/openappa/service";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  applyResumedChatOpsReviews,
  authorizeChatOpsReviewResume,
  readChatOpsReview,
  shouldInstallDurableReview,
} from "./chatops-review";

setupTestCacheManager();

const SECRET = "test-offer-signing-secret-32chars";
const LEDGER_TEXT = "Approve sending this message?";
const LEDGER_ARGS = JSON.stringify({ to: "person@example.com" });
const TOOL = "slack_send_message";

describe("chatops OpenAPPA review", () => {
  const original = { ...config.openappa };

  beforeEach(() => {
    config.openappa = {
      enabled: true,
      yellEnabled: false,
      offerSigningSecret: SECRET,
      postgresMaxConnections: 10,
    };
  });

  afterEach(() => {
    config.openappa = original;
    vi.restoreAllMocks();
  });

  test("does not install a durable pause for a system actor or a delegated child", () => {
    expect(
      shouldInstallDurableReview({ source: "email", userId: "system" }),
    ).toBe(false);
    expect(
      shouldInstallDurableReview({
        source: "email",
        userId: crypto.randomUUID(),
        parentDelegationChain: "parent",
      }),
    ).toBe(false);
    expect(
      shouldInstallDurableReview({
        source: "schedule",
        userId: crypto.randomUUID(),
      }),
    ).toBe(false);
    expect(
      shouldInstallDurableReview({
        source: "email",
        userId: crypto.randomUUID(),
      }),
    ).toBe(true);
  });

  test("shows ledger text to the signing user and blocks everyone else", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const other = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: user.id,
    });
    const seeded = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
    });
    mockLedger();

    const view = await readChatOpsReview({
      taskId: seeded.taskId,
      approvalId: seeded.approvalId,
      reviewerUserId: user.id,
      organizationId: org.id,
    });
    expect(view).toMatchObject({
      kind: "ready",
      view: { text: LEDGER_TEXT, tool: TOOL, arguments: LEDGER_ARGS },
    });

    const wrongActor = await authorizeChatOpsReviewResume({
      taskId: seeded.taskId,
      approvalId: seeded.approvalId,
      reviewerUserId: other.id,
      organizationId: org.id,
    });
    expect(wrongActor).toEqual({ kind: "blocked", reason: "wrong_actor" });
    expect(
      await authorizeChatOpsReviewResume({
        taskId: seeded.taskId,
        approvalId: seeded.approvalId,
        reviewerUserId: other.id,
        organizationId: org.id,
        toolName: "pretend-legacy-tool",
      }),
    ).toEqual({ kind: "blocked", reason: "wrong_actor" });

    const otherOrg = await makeOrganization();
    const wrongOrg = await authorizeChatOpsReviewResume({
      taskId: seeded.taskId,
      approvalId: seeded.approvalId,
      reviewerUserId: user.id,
      organizationId: otherOrg.id,
    });
    expect(wrongOrg).toEqual({ kind: "blocked", reason: "wrong_org" });
  });

  test("blocks a null caller and an expired stage", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: user.id,
    });
    const missing = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      callerId: null,
      stage: false,
    });
    expect(
      await authorizeChatOpsReviewResume({
        taskId: missing.taskId,
        approvalId: missing.approvalId,
        reviewerUserId: user.id,
        organizationId: org.id,
      }),
    ).toEqual({ kind: "blocked", reason: "missing_reviewer" });

    const expired = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      stage: false,
    });
    expect(
      await authorizeChatOpsReviewResume({
        taskId: expired.taskId,
        approvalId: expired.approvalId,
        reviewerUserId: user.id,
        organizationId: org.id,
      }),
    ).toEqual({ kind: "blocked", reason: "expired" });
  });

  test("refuses a tampered message and denies with the staged args", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: user.id,
    });
    const tampered = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      messageArguments: { offer_id: "offer-1", plan: "attacker" },
    });
    const execute = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({ result: { content: [] }, known: true });
    expect(
      await authorizeChatOpsReviewResume({
        taskId: tampered.taskId,
        approvalId: tampered.approvalId,
        reviewerUserId: user.id,
        organizationId: org.id,
      }),
    ).toEqual({ kind: "blocked", reason: "args_mismatch" });
    expect(execute).not.toHaveBeenCalled();

    const seeded = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
    });
    mockLedger();
    const message = reviewMessage({
      approvalId: seeded.approvalId,
      input: seeded.input,
      approved: false,
      state: "approval-responded",
    });
    await resolveReview(seeded, false);
    await applyResumedChatOpsReviews({
      messages: [message],
      reviewerUserId: user.id,
      organizationId: org.id,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        ruling: "deny",
        sessionId: seeded.sessionId,
        args: { offer_id: seeded.offerId },
        ownerCallerId: `user:${user.id}`,
      }),
    );
    expect(execute.mock.calls[0]?.[0].args).not.toMatchObject({
      plan: "attacker",
    });
    expect(
      await A2ATaskApprovalRequestModel.findByApprovalId(seeded.approvalId),
    ).toBeNull();
    await applyResumedChatOpsReviews({
      messages: [message],
      reviewerUserId: user.id,
      organizationId: org.id,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("records an approval the restarted process can consume once", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: user.id,
    });
    const seeded = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
    });
    mockLedger();
    const gate = await authorizeChatOpsReviewResume({
      taskId: seeded.taskId,
      approvalId: seeded.approvalId,
      reviewerUserId: user.id,
      organizationId: org.id,
    });
    expect(gate).toMatchObject({
      kind: "allowed",
      sessionId: seeded.sessionId,
    });

    await resolveReview(seeded, true);
    expect(
      await A2ATaskApprovalRequestModel.findByApprovalId(seeded.approvalId),
    ).toMatchObject({ resolved: true, approved: true, toolCallId: "call-1" });
    const applied = await applyResumedChatOpsReviews({
      messages: [
        reviewMessage({
          approvalId: seeded.approvalId,
          input: seeded.input,
          approved: true,
          state: "approval-responded",
        }),
      ],
      reviewerUserId: user.id,
      organizationId: org.id,
    });
    expect(applied).toEqual({ blockedApprovalIds: [] });
    await A2ATaskApprovalRequestModel.bulkCreateRaw([
      {
        taskId: seeded.taskId,
        approvalId: "other-unconsumed",
        toolCallId: "other-call",
        toolName: TOOL,
        approved: false,
        resolved: false,
      },
    ]);

    const session = {
      organization_id: org.id,
      session_id: seeded.sessionId,
      caller_id: `user:${user.id}`,
    };
    expect(
      await consumeHitlRuling({
        session: { ...session, session_id: "other-session" },
        offerId: seeded.offerId,
      }),
    ).toBeUndefined();
    expect(
      await A2ATaskApprovalRequestModel.findByApprovalId(seeded.approvalId),
    ).toMatchObject({ resolved: true, approved: true });
    expect(await consumeHitlRuling({ session, offerId: seeded.offerId })).toBe(
      "approve",
    );
    expect(
      await A2ATaskApprovalRequestModel.findByApprovalId(seeded.approvalId),
    ).toBeNull();
    expect(
      await A2ATaskApprovalRequestModel.findByApprovalId("other-unconsumed"),
    ).toMatchObject({ resolved: false });
    expect(await consumeHitlRuling({ session, offerId: seeded.offerId })).toBe(
      undefined,
    );
  });

  test("does not record a ruling when the ledger no longer matches the stage", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: user.id,
    });
    const seeded = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
    });
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: seeded.offerId,
      text: LEDGER_TEXT,
      session_id: seeded.sessionId,
      tool: TOOL,
      arguments: JSON.stringify({ to: "attacker@example.com" }),
    });
    const execute = vi.spyOn(openappaService, "executeRemedyByOffer");
    expect(
      await authorizeChatOpsReviewResume({
        taskId: seeded.taskId,
        approvalId: seeded.approvalId,
        reviewerUserId: user.id,
        organizationId: org.id,
      }),
    ).toEqual({ kind: "blocked", reason: "args_mismatch" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("a supplied approved part cannot authorize an unresolved or denied row", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: user.id,
    });
    const seeded = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
    });
    mockLedger();
    const messages = [
      reviewMessage({
        approvalId: seeded.approvalId,
        input: seeded.input,
        approved: true,
        state: "approval-responded",
      }),
    ];
    const execute = vi.spyOn(openappaService, "executeRemedyByOffer");
    const apply = () =>
      applyResumedChatOpsReviews({
        messages,
        reviewerUserId: user.id,
        organizationId: org.id,
      });
    await expect(apply()).resolves.toEqual({
      blockedApprovalIds: [seeded.approvalId],
    });
    await resolveReview(seeded, false);
    await expect(apply()).resolves.toEqual({
      blockedApprovalIds: [seeded.approvalId],
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(
      consumeHitlRuling({
        session: {
          organization_id: org.id,
          session_id: seeded.sessionId,
          caller_id: `user:${user.id}`,
        },
        offerId: seeded.offerId,
      }),
    ).resolves.toBeUndefined();
  });

  test("a resumed part cannot spend the recorded approval on a different plan", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: user.id,
    });
    const seeded = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
    });
    mockLedger();
    await resolveReview(seeded, true);
    const applied = await applyResumedChatOpsReviews({
      messages: [
        reviewMessage({
          approvalId: seeded.approvalId,
          input: { ...seeded.input, plan: "different-plan" },
          approved: true,
          state: "approval-responded",
        }),
      ],
      reviewerUserId: user.id,
      organizationId: org.id,
    });
    expect(applied).toEqual({ blockedApprovalIds: [seeded.approvalId] });
    expect(
      await A2ATaskApprovalRequestModel.findByApprovalId(seeded.approvalId),
    ).toMatchObject({ resolved: true, approved: true });
    await expect(
      consumeHitlRuling({
        session: {
          organization_id: org.id,
          session_id: seeded.sessionId,
          caller_id: `user:${user.id}`,
        },
        offerId: seeded.offerId,
      }),
    ).resolves.toBeUndefined();
  });

  test("a resolved approval cannot be decided again", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: user.id,
    });
    const seeded = await seedReview({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      resolved: true,
    });
    expect(
      await authorizeChatOpsReviewResume({
        taskId: seeded.taskId,
        approvalId: seeded.approvalId,
        reviewerUserId: user.id,
        organizationId: org.id,
      }),
    ).toEqual({ kind: "blocked", reason: "already_resolved" });
  });
});

function mockLedger() {
  vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
    offer_id: "offer-1",
    text: LEDGER_TEXT,
    session_id: "session-1",
    tool: TOOL,
    arguments: LEDGER_ARGS,
  });
}

async function seedReview(params: {
  organizationId: string;
  userId: string;
  agentId: string;
  callerId?: string | null;
  stage?: boolean;
  resolved?: boolean;
  messageArguments?: Record<string, unknown>;
}) {
  if (!(await MemberModel.getByUserId(params.userId, params.organizationId))) {
    await MemberModel.create(params.userId, params.organizationId, "member");
  }
  const offerId = "offer-1";
  const sessionId = "session-1";
  const callerId =
    params.callerId === undefined ? `user:${params.userId}` : params.callerId;
  const remedyArguments = { offer_id: offerId, plan: "real-plan" };
  const jws = signOfferClaims(
    unsignedOfferClaims({
      organizationId: params.organizationId,
      sessionId,
      offerId,
      callerId: callerId ?? undefined,
      tool: TOOL,
    }),
    SECRET,
  );
  const input = {
    ...(params.messageArguments ?? remedyArguments),
    ...jws,
  };
  const approvalId = crypto.randomUUID();
  const actor: A2AActor = {
    kind: "user",
    id: params.userId,
    organizationId: params.organizationId,
  };
  const context = await A2AContextManager.createContext(actor);
  const uiMessage = reviewMessage({
    approvalId,
    input,
    state: "approval-requested",
  });
  const task = await A2ATaskManager.createTask({
    context,
    actor,
    state: A2AProtocolTaskState.InputRequired,
    agentId: params.agentId,
    approvalRequests: [
      {
        approvalId,
        toolCallId: "call-1",
        toolName: TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
        approved: false,
        resolved: params.resolved ?? false,
      },
    ],
  });
  await A2ATaskManager.addMessageToTask({
    task,
    message: {
      messageId: uiMessage.id,
      contextId: context.id,
      taskId: task.id,
      role: A2AProtocolRole.Agent,
      parts: [{ text: "Review required" }],
    },
    uiMessage,
  });
  if (params.stage !== false && callerId) {
    await stageHitlReview({
      session: {
        organization_id: params.organizationId,
        session_id: sessionId,
        caller_id: callerId,
      },
      review: {
        offerId,
        text: LEDGER_TEXT,
        tool: TOOL,
        arguments: LEDGER_ARGS,
        remedyArguments,
      },
    });
  }
  return {
    taskId: task.id,
    contextId: context.id,
    messageId: uiMessage.id,
    approvalId,
    input,
    offerId,
    sessionId,
  };
}

async function resolveReview(
  seeded: Awaited<ReturnType<typeof seedReview>>,
  approved: boolean,
) {
  const result = await A2ATaskModel.applyApprovalDecisionsAndMaybeResume({
    taskId: seeded.taskId,
    lastMessageId: seeded.messageId,
    preserveResolvedApprovals: true,
    approvalDecisions: [{ approvalId: seeded.approvalId, approved }],
    applyDecisionsToContent: () => ({
      ...reviewMessage({
        approvalId: seeded.approvalId,
        input: seeded.input,
        state: "approval-responded",
        approved,
      }),
      id: seeded.messageId,
    }),
    resumeEventPayload: {
      statusUpdate: {
        taskId: seeded.taskId,
        contextId: seeded.contextId,
        status: { state: A2AProtocolTaskState.Working },
      },
    },
  });
  expect(result.outcome).toBe("resumed");
}

function reviewMessage(params: {
  approvalId: string;
  input: Record<string, unknown>;
  state: "approval-requested" | "approval-responded";
  approved?: boolean;
}): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: `tool-${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}`,
        toolCallId: "call-1",
        state: params.state,
        input: params.input,
        approval: {
          id: params.approvalId,
          ...(params.approved === undefined
            ? {}
            : { approved: params.approved }),
        },
      },
    ],
  } as UIMessage;
}
