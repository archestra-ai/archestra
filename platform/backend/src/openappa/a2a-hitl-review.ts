import {
  TimeInMs,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import { A2AError, A2AErrorKind } from "@/agents/a2a/a2a-base";
import type { A2AArchestraApprovalRequest } from "@/agents/a2a/a2a-protocol";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import logger from "@/logging";
import { A2ATaskApprovalRequestModel } from "@/models";
import type { A2ATaskApprovalRequest } from "@/types";
import { parseCurrentTrajectory } from "./current-trajectory";
import {
  recordHitlRuling,
  reviewSessionFromTrajectory,
  stageHitlReview,
} from "./hitl-review";
import { loadOfferReview } from "./service";

/**
 * How long a paused review waits for an answer. OpenAPPA offers have no clock
 * of their own; past this the A2A reaper cancels the paused task.
 *
 * @internal exported for tests
 */
export const A2A_HITL_REVIEW_TTL_MS = 24 * TimeInMs.Hour;

/**
 * The A2A pause gate: an `execute_remedy_plan` call needs a human ruling when
 * its proxy-stamped offer carries an OpenAPPA review. The tool re-checks
 * everything when it runs after the answer.
 */
export async function remedyCallNeedsHumanReview(params: {
  organizationId: string;
  input: unknown;
}): Promise<boolean> {
  const offer = reviewedOffer(params.input);
  if (!offer) return false;
  const review = await loadOfferReview({
    organizationId: params.organizationId,
    sessionId: offer.sessionId,
    offerId: offer.offerId,
  });
  return review !== null;
}

/**
 * Who answers a paused review: one chat user (Slack or MS Teams) in one
 * thread, or whoever can
 * send `taskOps.approvalDecisions` for the task over A2A.
 */
type HitlReviewAnswerer =
  | {
      kind: "chat";
      reviewerUserId: string;
      channelId: string;
      threadId: string | undefined;
    }
  | { kind: "caller" };

/** What a chat surface shows for one OpenAPPA review. */
type HitlReviewDisplay = {
  text: string;
  /** The reviewed call's tool, as OpenAPPA proposed it for ruling. */
  tool?: string;
  /** The reviewed call's arguments as JSON text. */
  arguments?: string;
};

/**
 * Links each paused `execute_remedy_plan` request to its OpenAPPA review and
 * its answerer. Returns the review per approval id; requests for other tools
 * are skipped.
 */
export async function attachHitlReviews(params: {
  organizationId: string;
  taskId: string;
  approvalRequests: A2AArchestraApprovalRequest[];
  answerer: HitlReviewAnswerer;
  now: Date;
}): Promise<Map<string, HitlReviewDisplay>> {
  const reviews = new Map<string, HitlReviewDisplay>();
  for (const request of params.approvalRequests) {
    if (!isRemedyTool(request.toolName) || !request.toolInput) continue;
    const offer = reviewedOffer(request.toolInput);
    if (!offer) continue;
    const review = await loadOfferReview({
      organizationId: params.organizationId,
      sessionId: offer.sessionId,
      offerId: offer.offerId,
    });
    if (!review) continue;
    const attached = await A2ATaskApprovalRequestModel.attachOpenappaReview({
      taskId: params.taskId,
      approvalId: request.approvalId,
      offerId: offer.offerId,
      reviewText: review.text,
      remedyArguments: request.toolInput,
      expiresAt: new Date(params.now.getTime() + A2A_HITL_REVIEW_TTL_MS),
      ...(params.answerer.kind === "chat" && {
        reviewerUserId: params.answerer.reviewerUserId,
        chatChannelId: params.answerer.channelId,
        chatThreadId: params.answerer.threadId,
      }),
    });
    if (attached)
      reviews.set(request.approvalId, {
        text: review.text,
        ...(review.tool ? { tool: review.tool } : {}),
        ...(review.arguments ? { arguments: review.arguments } : {}),
      });
  }
  return reviews;
}

export type ChatHitlDecision =
  | { status: "not_openappa" }
  | { status: "recorded"; ruling: "approve" | "deny" }
  | { status: "forbidden"; reviewerUserId: string | null }
  | { status: "already_decided"; ruling: "approve" | "deny" }
  | { status: "expired" }
  | { status: "closed" };

/**
 * Records a chat reviewer's click for the exact offer the paused task waits
 * on, then hands the ruling to `execute_remedy_plan`. The resumed run spends
 * it once; OpenAPPA decides what it allows.
 */
export async function decideChatHitlReview(params: {
  organizationId: string;
  taskId: string;
  approvalId: string;
  clickerUserId: string;
  clickChannelId: string;
  approved: boolean;
  now: Date;
}): Promise<ChatHitlDecision> {
  const row = await A2ATaskApprovalRequestModel.findByTaskIdAndApprovalId({
    taskId: params.taskId,
    approvalId: params.approvalId,
  });
  // A resumed or canceled task has no rows left: its review is over.
  if (!row) return { status: "closed" };
  if (!row.openappaOfferId) return { status: "not_openappa" };
  if (
    row.reviewerUserId !== params.clickerUserId ||
    row.chatChannelId !== params.clickChannelId
  ) {
    return { status: "forbidden", reviewerUserId: row.reviewerUserId };
  }
  const ruling = params.approved ? "approve" : "deny";
  const recorded = await A2ATaskApprovalRequestModel.recordOpenappaRuling({
    id: row.id,
    reviewerUserId: params.clickerUserId,
    ruling,
    now: params.now,
  });
  if (!recorded) {
    const current = await A2ATaskApprovalRequestModel.findById(row.id);
    return current?.ruling
      ? { status: "already_decided", ruling: current.ruling }
      : { status: "expired" };
  }
  await handRulingToRemedyCall({
    organizationId: params.organizationId,
    row: recorded,
    ruling,
    userId: params.clickerUserId,
  });
  return { status: "recorded", ruling };
}

/**
 * Records the A2A caller's decisions on OpenAPPA reviews, as the caller has
 * always answered tool approvals on this surface. Returns the decisions to
 * apply to the paused tool calls: an answered review always lets
 * `execute_remedy_plan` run, so a decline also reaches OpenAPPA, which closes
 * the offer.
 */
export async function decideCallerHitlReviews(params: {
  organizationId: string;
  taskId: string;
  userId: string;
  approvalDecisions: Array<{ approvalId: string; approved: boolean }>;
  now: Date;
}): Promise<Array<{ approvalId: string; approved: boolean }>> {
  const reviews = new Map<string, A2ATaskApprovalRequest>();
  // Check every decision before recording any, so one refused decision does
  // not leave the others spent on a task that never resumes.
  for (const decision of params.approvalDecisions) {
    const row = await A2ATaskApprovalRequestModel.findByTaskIdAndApprovalId({
      taskId: params.taskId,
      approvalId: decision.approvalId,
    });
    if (!row?.openappaOfferId) continue;
    if (row.reviewerUserId !== null) {
      throw new A2AError(
        A2AErrorKind.UnsupportedOperation,
        "this OpenAPPA review is answered in chat",
      );
    }
    if (row.ruling) throw new A2AError(A2AErrorKind.ApprovalIdAlreadyResolved);
    if (!row.expiresAt || row.expiresAt <= params.now) {
      throw new A2AError(
        A2AErrorKind.UnsupportedOperation,
        "the OpenAPPA review expired, so the action stays blocked",
      );
    }
    reviews.set(decision.approvalId, row);
  }

  const decisions = [];
  for (const decision of params.approvalDecisions) {
    const row = reviews.get(decision.approvalId);
    if (!row) {
      decisions.push(decision);
      continue;
    }
    const ruling = decision.approved ? "approve" : "deny";
    const recorded = await A2ATaskApprovalRequestModel.recordOpenappaRuling({
      id: row.id,
      reviewerUserId: null,
      ruling,
      now: params.now,
    });
    if (!recorded) throw new A2AError(A2AErrorKind.ApprovalIdAlreadyResolved);
    await handRulingToRemedyCall({
      organizationId: params.organizationId,
      row: recorded,
      ruling,
      userId: params.userId,
    });
    decisions.push({ approvalId: decision.approvalId, approved: true });
  }
  return decisions;
}

/**
 * Stages the review and its ruling in the HITL review cache, where the
 * resumed `execute_remedy_plan` call reads it once.
 */
async function handRulingToRemedyCall(params: {
  organizationId: string;
  row: A2ATaskApprovalRequest;
  ruling: "approve" | "deny";
  /** The resumed run's actor. */
  userId: string;
}): Promise<void> {
  const { row, ruling } = params;
  const offer = reviewedOffer(row.remedyArguments);
  if (!offer || !row.remedyArguments || !row.openappaReviewText) {
    throw new Error("Stored OpenAPPA review is incomplete");
  }
  // The resumed run computes the same scope: same trajectory, same actor,
  // and no persisted conversation.
  const session = reviewSessionFromTrajectory({
    organizationId: params.organizationId,
    trajectory: offer.trajectory,
    context: { userId: params.userId },
  });
  const {
    execution: _execution,
    trajectory: _trajectory,
    ...remedyArguments
  } = row.remedyArguments;
  const staged = await stageHitlReview({
    session,
    review: {
      offerId: offer.offerId,
      text: row.openappaReviewText,
      remedyArguments,
    },
  });
  if (staged.status !== "staged") {
    throw new Error("Could not record the OpenAPPA ruling");
  }
  if (!(await recordHitlRuling({ session, offerId: offer.offerId, ruling }))) {
    throw new Error("Could not record the OpenAPPA ruling");
  }
  logger.info(
    { taskId: row.taskId, offerId: offer.offerId, ruling },
    "OpenAPPA review of a paused A2A task decided",
  );
}

function isRemedyTool(toolName: string): boolean {
  return (
    archestraMcpBranding.getToolShortName(toolName) ===
    TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME
  );
}

function reviewedOffer(input: unknown):
  | {
      offerId: string;
      sessionId: string;
      trajectory: { session_id: string; parent_id?: string };
    }
  | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { offer_id: offerId, trajectory } = input as {
    offer_id?: unknown;
    trajectory?: unknown;
  };
  const stamp = parseCurrentTrajectory(trajectory);
  if (typeof offerId !== "string" || !offerId || !stamp) return undefined;
  return { offerId, sessionId: stamp.session_id, trajectory: stamp };
}
