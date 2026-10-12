import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { A2AErrorKind } from "@/agents/a2a/a2a-base";
import {
  type A2AArchestraApprovalRequest,
  A2AProtocolTaskState,
} from "@/agents/a2a/a2a-protocol";
import { a2aTaskRunService } from "@/agents/a2a/a2a-task-run-service";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import db, { schema } from "@/database";
import {
  A2AContextModel,
  A2ATaskApprovalRequestModel,
  A2ATaskModel,
} from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  A2A_HITL_REVIEW_TTL_MS,
  attachHitlReviews,
  decideCallerHitlReviews,
  decideSlackHitlReview,
  remedyCallNeedsHumanReview,
} from "./a2a-hitl-review";
import { consumeHitlRuling, reviewSessionFromTrajectory } from "./hitl-review";
import * as openappaService from "./service";

setupTestCacheManager();

const SESSION_ID = "chatops:slack:C123:1700000000.000100";
const NOW = new Date("2026-10-12T10:00:00Z");

function remedyInput(offerId: string) {
  return {
    offer_id: offerId,
    plan: "ask a human",
    trajectory: { v: 1, session_id: SESSION_ID },
    execution: { call_id: "call-1", tool_name: "execute_remedy_plan" },
  };
}

function stubReview(offerId: string) {
  vi.spyOn(openappaService, "loadOfferReview").mockImplementation(
    async (params) =>
      params.offerId === offerId && params.sessionId === SESSION_ID
        ? {
            offer_id: offerId,
            text: "Approve this call?\nsend_email to ceo@example.com",
            session_id: SESSION_ID,
            tool: "send_email",
            arguments: '{"to":"ceo@example.com"}',
          }
        : null,
  );
}

async function pausedReview(params: {
  organizationId: string;
  reviewerUserId: string;
  offerId: string;
  now?: Date;
}) {
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: params.reviewerUserId,
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
      toolInput: remedyInput(params.offerId),
      approved: false,
      resolved: false,
    },
    {
      approvalId: "approval-2",
      toolCallId: "call-2",
      toolName: "github__create_issue",
      toolInput: { title: "x" },
      approved: false,
      resolved: false,
    },
  ];
  await A2ATaskApprovalRequestModel.bulkCreate({
    taskId: task.id,
    approvalRequests,
  });
  const reviewTexts = await attachHitlReviews({
    organizationId: params.organizationId,
    taskId: task.id,
    approvalRequests,
    answerer: {
      kind: "slack",
      reviewerUserId: params.reviewerUserId,
      channelId: "C123",
      threadTs: "1700000000.000100",
    },
    now: params.now ?? NOW,
  });
  return { task, reviewTexts };
}

test("the gate pauses only a remedy call whose offer carries a review", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  stubReview("offer-1");

  expect(
    await remedyCallNeedsHumanReview({
      organizationId: org.id,
      input: remedyInput("offer-1"),
    }),
  ).toBe(true);
  expect(
    await remedyCallNeedsHumanReview({
      organizationId: org.id,
      input: remedyInput("offer-without-review"),
    }),
  ).toBe(false);
  // Without the proxy stamp there is no session to find the offer in.
  expect(
    await remedyCallNeedsHumanReview({
      organizationId: org.id,
      input: { offer_id: "offer-1" },
    }),
  ).toBe(false);
});

test("a paused remedy call is linked to its offer, reviewer, thread and expiry", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const reviewer = await makeUser();
  stubReview("offer-1");

  const { task, reviewTexts } = await pausedReview({
    organizationId: org.id,
    reviewerUserId: reviewer.id,
    offerId: "offer-1",
  });

  expect([...reviewTexts.keys()]).toEqual(["approval-1"]);
  const rows = await A2ATaskApprovalRequestModel.findByTaskId(task.id);
  const remedy = rows.find((row) => row.approvalId === "approval-1");
  const other = rows.find((row) => row.approvalId === "approval-2");
  expect(remedy).toMatchObject({
    openappaOfferId: "offer-1",
    openappaReviewText: "Approve this call?\nsend_email to ceo@example.com",
    remedyArguments: remedyInput("offer-1"),
    reviewerUserId: reviewer.id,
    slackChannelId: "C123",
    slackThreadTs: "1700000000.000100",
    expiresAt: new Date(NOW.getTime() + A2A_HITL_REVIEW_TTL_MS),
    ruling: null,
  });
  expect(other?.openappaOfferId).toBeNull();
});

test("the reviewer's approval reaches the resumed remedy call exactly once", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const reviewer = await makeUser();
  stubReview("offer-1");
  const { task } = await pausedReview({
    organizationId: org.id,
    reviewerUserId: reviewer.id,
    offerId: "offer-1",
  });

  const decide = () =>
    decideSlackHitlReview({
      organizationId: org.id,
      taskId: task.id,
      approvalId: "approval-1",
      clickerUserId: reviewer.id,
      clickChannelId: "C123",
      approved: true,
      now: NOW,
    });
  const [first, second] = await Promise.all([decide(), decide()]);

  expect([first, second]).toEqual(
    expect.arrayContaining([
      { status: "recorded", ruling: "approve" },
      { status: "already_decided", ruling: "approve" },
    ]),
  );
  // `execute_remedy_plan` derives this scope from the stamp and the resumed
  // actor; it must find the ruling there.
  const session = reviewSessionFromTrajectory({
    organizationId: org.id,
    trajectory: { session_id: SESSION_ID },
    context: { userId: reviewer.id },
  });
  expect(await consumeHitlRuling({ session, offerId: "offer-1" })).toBe(
    "approve",
  );
  expect(
    await consumeHitlRuling({ session, offerId: "offer-1" }),
  ).toBeUndefined();
});

test("a decline is recorded as a deny ruling for OpenAPPA to close the offer", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const reviewer = await makeUser();
  stubReview("offer-1");
  const { task } = await pausedReview({
    organizationId: org.id,
    reviewerUserId: reviewer.id,
    offerId: "offer-1",
  });

  expect(
    await decideSlackHitlReview({
      organizationId: org.id,
      taskId: task.id,
      approvalId: "approval-1",
      clickerUserId: reviewer.id,
      clickChannelId: "C123",
      approved: false,
      now: NOW,
    }),
  ).toEqual({ status: "recorded", ruling: "deny" });
  const session = reviewSessionFromTrajectory({
    organizationId: org.id,
    trajectory: { session_id: SESSION_ID },
    context: { userId: reviewer.id },
  });
  expect(await consumeHitlRuling({ session, offerId: "offer-1" })).toBe("deny");
});

test("another user, another channel, or a late click records nothing", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const reviewer = await makeUser();
  const bystander = await makeUser();
  stubReview("offer-1");
  const { task } = await pausedReview({
    organizationId: org.id,
    reviewerUserId: reviewer.id,
    offerId: "offer-1",
  });
  const click = (overrides: {
    clickerUserId?: string;
    clickChannelId?: string;
    now?: Date;
  }) =>
    decideSlackHitlReview({
      organizationId: org.id,
      taskId: task.id,
      approvalId: "approval-1",
      clickerUserId: reviewer.id,
      clickChannelId: "C123",
      approved: true,
      now: NOW,
      ...overrides,
    });

  expect(await click({ clickerUserId: bystander.id })).toEqual({
    status: "forbidden",
    reviewerUserId: reviewer.id,
  });
  expect(await click({ clickChannelId: "C999" })).toEqual({
    status: "forbidden",
    reviewerUserId: reviewer.id,
  });
  expect(
    await click({
      now: new Date(NOW.getTime() + A2A_HITL_REVIEW_TTL_MS + 1),
    }),
  ).toEqual({ status: "expired" });

  const [row] = (
    await A2ATaskApprovalRequestModel.findByTaskId(task.id)
  ).filter((r) => r.approvalId === "approval-1");
  expect(row.ruling).toBeNull();
  const session = reviewSessionFromTrajectory({
    organizationId: org.id,
    trajectory: { session_id: SESSION_ID },
    context: { userId: reviewer.id },
  });
  expect(
    await consumeHitlRuling({ session, offerId: "offer-1" }),
  ).toBeUndefined();
});

test("a click on a resumed task's review, or on a plain tool approval, is not an OpenAPPA ruling", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const reviewer = await makeUser();
  stubReview("offer-1");
  const { task } = await pausedReview({
    organizationId: org.id,
    reviewerUserId: reviewer.id,
    offerId: "offer-1",
  });
  const click = (taskId: string, approvalId: string) =>
    decideSlackHitlReview({
      organizationId: org.id,
      taskId,
      approvalId,
      clickerUserId: reviewer.id,
      clickChannelId: "C123",
      approved: true,
      now: NOW,
    });

  expect(await click(task.id, "approval-2")).toEqual({
    status: "not_openappa",
  });
  expect(await click(crypto.randomUUID(), "approval-1")).toEqual({
    status: "closed",
  });
});

test("the reaper cancels a task whose review expired and leaves a live one paused", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const reviewer = await makeUser();
  stubReview("offer-1");
  const { task: expired } = await pausedReview({
    organizationId: org.id,
    reviewerUserId: reviewer.id,
    offerId: "offer-1",
    now: new Date(Date.now() - A2A_HITL_REVIEW_TTL_MS - 1000),
  });
  const { task: live } = await pausedReview({
    organizationId: org.id,
    reviewerUserId: reviewer.id,
    offerId: "offer-1",
    now: new Date(),
  });

  await a2aTaskRunService.reapStale();

  expect((await A2ATaskModel.findById(expired.id))?.state).toBe(
    A2AProtocolTaskState.Canceled,
  );
  expect(await A2ATaskApprovalRequestModel.findByTaskId(expired.id)).toEqual(
    [],
  );
  expect((await A2ATaskModel.findById(live.id))?.state).toBe(
    A2AProtocolTaskState.InputRequired,
  );
});

async function callerPausedReview(params: {
  organizationId: string;
  now: Date;
}) {
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: crypto.randomUUID(),
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    state: A2AProtocolTaskState.InputRequired,
  });
  const approvalRequests: A2AArchestraApprovalRequest[] = [
    "approval-1",
    "approval-3",
  ].map((approvalId) => ({
    approvalId,
    toolCallId: `call-${approvalId}`,
    toolName: archestraMcpBranding.getToolName("execute_remedy_plan"),
    toolInput: remedyInput("offer-1"),
    approved: false,
    resolved: false,
  }));
  approvalRequests.push({
    approvalId: "approval-2",
    toolCallId: "call-2",
    toolName: "github__create_issue",
    toolInput: { title: "x" },
    approved: false,
    resolved: false,
  });
  await A2ATaskApprovalRequestModel.bulkCreate({
    taskId: task.id,
    approvalRequests,
  });
  await attachHitlReviews({
    organizationId: params.organizationId,
    taskId: task.id,
    approvalRequests,
    answerer: { kind: "caller" },
    now: params.now,
  });
  return task;
}

test("the caller's decision answers the review; a plain approval passes through", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  stubReview("offer-1");
  const task = await callerPausedReview({ organizationId: org.id, now: NOW });

  const decisions = await decideCallerHitlReviews({
    organizationId: org.id,
    taskId: task.id,
    userId: "system",
    approvalDecisions: [
      { approvalId: "approval-1", approved: false },
      { approvalId: "approval-2", approved: false },
    ],
    now: NOW,
  });

  // The remedy call runs either way so OpenAPPA sees the deny; the plain
  // tool approval keeps the caller's answer.
  expect(decisions).toEqual([
    { approvalId: "approval-1", approved: true },
    { approvalId: "approval-2", approved: false },
  ]);
  const session = reviewSessionFromTrajectory({
    organizationId: org.id,
    trajectory: { session_id: SESSION_ID },
    context: { userId: "system" },
  });
  expect(await consumeHitlRuling({ session, offerId: "offer-1" })).toBe("deny");
  await expect(
    decideCallerHitlReviews({
      organizationId: org.id,
      taskId: task.id,
      userId: "system",
      approvalDecisions: [{ approvalId: "approval-1", approved: true }],
      now: NOW,
    }),
  ).rejects.toMatchObject({ kind: A2AErrorKind.ApprovalIdAlreadyResolved });
});

test("an expired review refuses the whole batch and records nothing", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  stubReview("offer-1");
  const task = await callerPausedReview({ organizationId: org.id, now: NOW });
  const rows = await A2ATaskApprovalRequestModel.findByTaskId(task.id);
  const late = rows.find((row) => row.approvalId === "approval-3");
  if (!late) throw new Error("missing row");
  await db
    .update(schema.a2aTaskApprovalRequestsTable)
    .set({ expiresAt: new Date(NOW.getTime() - 1) })
    .where(eq(schema.a2aTaskApprovalRequestsTable.id, late.id));

  await expect(
    decideCallerHitlReviews({
      organizationId: org.id,
      taskId: task.id,
      userId: "system",
      approvalDecisions: [
        { approvalId: "approval-1", approved: true },
        { approvalId: "approval-3", approved: true },
      ],
      now: NOW,
    }),
  ).rejects.toMatchObject({ kind: A2AErrorKind.UnsupportedOperation });
  expect(
    (await A2ATaskApprovalRequestModel.findByTaskId(task.id)).map(
      (row) => row.ruling,
    ),
  ).toEqual([null, null, null]);
});

test("a review owned by a Slack reviewer cannot be answered over A2A", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const reviewer = await makeUser();
  stubReview("offer-1");
  const { task } = await pausedReview({
    organizationId: org.id,
    reviewerUserId: reviewer.id,
    offerId: "offer-1",
  });

  await expect(
    decideCallerHitlReviews({
      organizationId: org.id,
      taskId: task.id,
      userId: reviewer.id,
      approvalDecisions: [{ approvalId: "approval-1", approved: true }],
      now: NOW,
    }),
  ).rejects.toMatchObject({ kind: A2AErrorKind.UnsupportedOperation });
});
