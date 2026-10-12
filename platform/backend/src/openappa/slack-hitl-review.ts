import {
  TimeInMs,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import type { A2AArchestraApprovalRequest } from "@/agents/a2a/a2a-protocol";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import logger from "@/logging";
import { A2ATaskApprovalRequestModel } from "@/models";
import { parseCurrentTrajectory } from "./current-trajectory";
import {
  recordHitlRuling,
  reviewSessionFromTrajectory,
  stageHitlReview,
} from "./hitl-review";
import { loadOfferReview } from "./service";

/**
 * How long a Slack reviewer has to answer. OpenAPPA offers have no clock of
 * their own; past this the A2A reaper cancels the paused task.
 *
 * @internal exported for tests
 */
export const SLACK_HITL_REVIEW_TTL_MS = 24 * TimeInMs.Hour;

/**
 * The A2A pause gate for Slack runs: an `execute_remedy_plan` call needs a
 * human ruling when its proxy-stamped offer carries an OpenAPPA review.
 * The tool re-checks everything when it runs after the reviewer answers.
 */
export async function remedyCallNeedsSlackReview(params: {
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
 * Links each paused `execute_remedy_plan` request to its OpenAPPA review,
 * reviewer and Slack thread. Returns the review text per approval id, for the
 * Slack form; requests for other tools are skipped.
 */
export async function attachSlackHitlReviews(params: {
  organizationId: string;
  taskId: string;
  reviewerUserId: string;
  slackChannelId: string;
  slackThreadTs: string | undefined;
  approvalRequests: A2AArchestraApprovalRequest[];
  now: Date;
}): Promise<Map<string, string>> {
  const reviewTexts = new Map<string, string>();
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
      reviewerUserId: params.reviewerUserId,
      slackChannelId: params.slackChannelId,
      slackThreadTs: params.slackThreadTs,
      expiresAt: new Date(params.now.getTime() + SLACK_HITL_REVIEW_TTL_MS),
    });
    if (attached) reviewTexts.set(request.approvalId, review.text);
  }
  return reviewTexts;
}

export type SlackHitlDecision =
  | { status: "not_openappa" }
  | { status: "recorded"; ruling: "approve" | "deny" }
  | { status: "forbidden"; reviewerUserId: string | null }
  | { status: "already_decided"; ruling: "approve" | "deny" }
  | { status: "expired" }
  | { status: "closed" };

/**
 * Records a Slack reviewer's click for the exact offer the paused task waits
 * on, then hands the ruling to `execute_remedy_plan` through the HITL review
 * cache. The resumed run spends it once; OpenAPPA decides what it allows.
 */
export async function decideSlackHitlReview(params: {
  organizationId: string;
  taskId: string;
  approvalId: string;
  clickerUserId: string;
  clickChannelId: string;
  approved: boolean;
  now: Date;
}): Promise<SlackHitlDecision> {
  const row = await A2ATaskApprovalRequestModel.findByTaskIdAndApprovalId({
    taskId: params.taskId,
    approvalId: params.approvalId,
  });
  // A resumed or canceled task has no rows left: its review is over.
  if (!row) return { status: "closed" };
  if (!row.openappaOfferId) return { status: "not_openappa" };
  if (
    row.reviewerUserId !== params.clickerUserId ||
    row.slackChannelId !== params.clickChannelId
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

  const offer = reviewedOffer(recorded.remedyArguments);
  if (!offer || !recorded.remedyArguments || !recorded.openappaReviewText) {
    throw new Error("Stored OpenAPPA review is incomplete");
  }
  // The resumed run computes the same scope: same trajectory, same actor
  // (only the reviewer may resume), and no persisted conversation.
  const session = reviewSessionFromTrajectory({
    organizationId: params.organizationId,
    trajectory: offer.trajectory,
    context: { userId: params.clickerUserId },
  });
  const {
    execution: _execution,
    trajectory: _trajectory,
    ...remedyArguments
  } = recorded.remedyArguments;
  await stageHitlReview({
    session,
    review: {
      offerId: offer.offerId,
      text: recorded.openappaReviewText,
      remedyArguments,
    },
  });
  if (!(await recordHitlRuling({ session, offerId: offer.offerId, ruling }))) {
    throw new Error(
      "Could not record the OpenAPPA ruling for the Slack review",
    );
  }
  logger.info(
    { taskId: params.taskId, offerId: offer.offerId, ruling },
    "OpenAPPA Slack review decided",
  );
  return { status: "recorded", ruling };
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
