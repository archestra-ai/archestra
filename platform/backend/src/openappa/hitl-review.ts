import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { dump as dumpYaml } from "js-yaml";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { parseWorkloadPrincipal } from "@/services/agent-runtime/runtime-identity";
import { sessionCallerId } from "./actor";
import { isCommandExecutionTool } from "./command-normalization";
import {
  type HitlReviewCard,
  hitlInspectionDigest,
  hitlReviewOverviewCard,
  needsHitlReviewInspection,
  renderHitlReviewText,
  withInspectDetailsOption,
} from "./hitl-review-overview";
import { summarizeHitlReview } from "./hitl-review-summary";
import {
  formatArgumentLines,
  parseReviewedArguments,
  reviewedToolLabel,
} from "./review-display";
import type { OpenAppaSession } from "./service";

type HitlRuling = "approve" | "deny" | "none";

type HitlClosureReason =
  | "declined"
  | "cancelled"
  | "unanswered"
  | "unavailable";

export type HitlReviewOutcome =
  | "review_required"
  | "review_declined"
  | "review_unanswered"
  | "review_cancelled"
  | "review_unavailable"
  | "review_invalid";

const HITL_REVIEW_OUTCOMES = [
  "review_required",
  "review_declined",
  "review_unanswered",
  "review_cancelled",
  "review_unavailable",
  "review_invalid",
] as const satisfies readonly HitlReviewOutcome[];

const HITL_CLOSURE_REASONS = [
  "declined",
  "cancelled",
  "unanswered",
  "unavailable",
] as const satisfies readonly HitlClosureReason[];

export function isHitlReviewOutcome(
  value: unknown,
): value is HitlReviewOutcome {
  return (
    typeof value === "string" &&
    (HITL_REVIEW_OUTCOMES as readonly string[]).includes(value)
  );
}

function isHitlClosureReason(value: unknown): value is HitlClosureReason {
  return (
    typeof value === "string" &&
    (HITL_CLOSURE_REASONS as readonly string[]).includes(value)
  );
}

/** A stored none without a closure is an old in-flight record, not a denial. */
export function reviewOutcomeFromClosure(
  closure: HitlClosureReason | undefined,
): Exclude<HitlReviewOutcome, "review_required"> {
  switch (closure) {
    case "declined":
      return "review_declined";
    case "cancelled":
      return "review_cancelled";
    case "unanswered":
      return "review_unanswered";
    case "unavailable":
      return "review_unavailable";
    default:
      return "review_invalid";
  }
}

export function closureFromReviewOutcome(
  outcome: Exclude<HitlReviewOutcome, "review_required" | "review_invalid">,
): HitlClosureReason {
  switch (outcome) {
    case "review_declined":
      return "declined";
    case "review_cancelled":
      return "cancelled";
    case "review_unanswered":
      return "unanswered";
    case "review_unavailable":
      return "unavailable";
  }
}

type PendingHitlReview = {
  offerId: string;
  text: string;
  tool?: string;
  arguments?: string;
  remedyArguments?: Record<string, unknown>;
  /** Generated reading aid, never part of the approved tool arguments. */
  summary?: string;
};

type HitlAskUserArguments = HitlReviewCard;

/**
 * The inspection state of a review whose native card offers "Inspect
 * details". `pending`: a signed Inspect answer arrived and the complete
 * review text has not been provably delivered; the next issued card carries
 * the text above it. `delivered`: an answer came back from a card issued
 * with the text, which only a client that received it can hold — the text
 * precedes the card in the same response. A re-staged review whose rendered
 * payload differs resets the state; a closed or ruled review has none.
 */
type HitlInspectionStatus = "pending" | "delivered";

const HITL_REVIEW_TTL_MS = 10 * TimeInMs.Minute;
/**
 * How long a client's own question about a review accepts its answer. The
 * review the question asks about is kept a full review window longer
 * (`renewHitlReview`), so the answer always finds the review it is read
 * against, and an approval given on the question's last second keeps its
 * context for as long as the ruling can be spent.
 */
export const HITL_QUESTION_TTL_MS = 30 * TimeInMs.Minute;
// Replay facts outlive live review claims, but abandoned history is not permanent.
const HITL_HISTORY_TTL_MS = 30 * TimeInMs.Day;
const HITL_RULINGS: readonly HitlRuling[] = ["approve", "none", "deny"];

/** Recovers the review cache scope from the proxy's current trajectory. */
export function reviewSessionFromTrajectory(params: {
  organizationId: string;
  trajectory: { session_id: string; parent_id?: string };
  context: { conversationId?: string; userId?: string };
}): OpenAppaSession {
  const separator = params.trajectory.session_id.indexOf("|");
  const prefix =
    separator > 0
      ? params.trajectory.session_id.slice(0, separator)
      : undefined;
  // Chat roots are unprefixed UUIDs. Only matching server-owned Chat context
  // can supply their caller; headers and child/foreign sessions cannot.
  const callerId =
    sessionCallerId(params.trajectory.session_id) ??
    (parseWorkloadPrincipal(prefix) ? prefix : undefined) ??
    (params.context.userId &&
    params.context.conversationId === params.trajectory.session_id &&
    !params.trajectory.parent_id
      ? `user:${params.context.userId}`
      : undefined);
  if (!callerId) {
    // An unscoped session hashes caller "" into every review key, so two
    // callers with the same trajectory would share one cache scope. Callers
    // that require a caller-bearing session must refuse such a session; the
    // recovery fallbacks above stay intact for paths that legitimately allow
    // an unscoped review session.
    logger.warn(
      {
        organizationId: params.organizationId,
        sessionId: params.trajectory.session_id,
        parentId: params.trajectory.parent_id,
      },
      "OpenAPPA review session has no resolvable caller and shares the unscoped cache scope",
    );
  }
  return {
    organization_id: params.organizationId,
    session_id: params.trajectory.session_id,
    ...(callerId ? { caller_id: callerId } : {}),
    ...(params.trajectory.parent_id
      ? { parent_id: params.trajectory.parent_id }
      : {}),
  };
}

export async function stageHitlReview(params: {
  session: OpenAppaSession;
  review: PendingHitlReview;
  callId?: string;
  prepareSummary?: boolean;
}): Promise<
  | { status: "staged" }
  | { status: "approve" | "deny" }
  | {
      status: "none";
      closure?: "declined" | "cancelled" | "unanswered" | "unavailable";
    }
> {
  const decision = await peekHitlDecision({
    session: params.session,
    offerId: params.review.offerId,
  });
  if (decision?.ruling === "none")
    return {
      status: "none",
      ...(decision.closure ? { closure: decision.closure } : {}),
    };
  if (decision) return { status: decision.ruling };
  // A stage that cannot be read fails closed: silently reading it as absent
  // would drop the presentation freeze for a review the user may already be
  // reading, and no fallback exists for staged state.
  const prior = await cacheManager.get<PendingHitlReview>(
    stagePresenceKey(params.session, params.review.offerId),
    { throwOnError: true },
  );
  // Freeze the presentation for a repeated offer. Regenerating a summary after
  // the user saw it would also change the native question used to bind answers.
  const samePayload =
    prior?.offerId === params.review.offerId &&
    prior.tool === params.review.tool &&
    prior.arguments === params.review.arguments &&
    prior.text === params.review.text;
  let summary = samePayload ? prior.summary : undefined;
  if (!samePayload && params.prepareSummary !== false) {
    try {
      summary = await summarizeHitlReview(params);
    } catch {
      logger.warn(
        "Approval summary unavailable; retaining the complete review",
      );
    }
  }
  const { summary: _untrustedSummary, ...exactReview } = params.review;
  const review = { ...exactReview, ...(summary ? { summary } : {}) };
  const staged = await cacheManager.withLock(
    stagePresenceKey(params.session, params.review.offerId),
    async (cache) => {
      const existing = await readLockedRulings(
        cache,
        params.session,
        params.review.offerId,
      );
      // A stored decision is immutable. Recreating the stage would let a late
      // approval replace a sealed closure or denial.
      if (existing.deny) return { status: "deny" as const };
      if (existing.approve) return { status: "approve" as const };
      if (existing.none) {
        const closure = closureOf(existing.none);
        return {
          status: "none" as const,
          ...(closure ? { closure } : {}),
        };
      }
      // Another request may have staged this offer while we generated the
      // reading aid. An already-issued presentation of the same call wins,
      // even without a summary. The remedy plan is not part of the
      // presentation: a repeated remedy call keeps the stage it finds.
      const issued = await cache.get<PendingHitlReview>(
        stagePresenceKey(params.session, params.review.offerId),
      );
      const sameStagedCall =
        issued?.offerId === params.review.offerId &&
        issued.tool === params.review.tool &&
        issued.arguments === params.review.arguments &&
        issued.text === params.review.text;
      if (sameStagedCall) {
        // The question a client already shows about this stage may still be
        // open, and that question was promised the review's lifetime
        // (`renewHitlReview`): re-staging must not reset it.
        const pending = await cache.get<PendingHitlReview>(
          reviewKey(params.session, params.review.offerId),
        );
        if (pending?.offerId !== params.review.offerId) {
          await cache.set(
            reviewKey(params.session, params.review.offerId),
            issued,
            HITL_REVIEW_TTL_MS,
          );
        }
        return { status: "staged" as const };
      }
      // A changed call re-staged under the same offer replaces the stage, so
      // its inspection digest binds answers to the payload now offered.
      await cache.set(
        stagePresenceKey(params.session, params.review.offerId),
        review,
        HITL_REVIEW_TTL_MS,
      );
      await cache.set(
        reviewKey(params.session, params.review.offerId),
        review,
        HITL_REVIEW_TTL_MS,
      );
      return { status: "staged" as const };
    },
  );
  if (staged.status === "staged" && params.callId) {
    await recordHitlReviewResult({
      session: params.session,
      callId: params.callId,
      offerId: params.review.offerId,
      outcome: "review_required",
    });
  }
  return staged;
}

/** A history fact only: it neither stages a live review nor grants a ruling. */
export async function recordHitlReviewResult(params: {
  session: OpenAppaSession;
  callId: string;
  offerId: string;
  outcome: HitlReviewOutcome;
}): Promise<void> {
  await cacheManager.set(
    scopedKey(
      CacheKey.OpenAppaHitlReviewHistory,
      params.session,
      JSON.stringify([params.callId, params.offerId]),
    ),
    { callId: params.callId, offerId: params.offerId, outcome: params.outcome },
    HITL_HISTORY_TTL_MS,
  );
}

export async function getHitlReviewResult(params: {
  session: OpenAppaSession;
  callId: string;
  offerId: string;
}): Promise<HitlReviewOutcome | undefined> {
  const record = await cacheManager.get<{
    callId: string;
    offerId: string;
    outcome?: HitlReviewOutcome;
  }>(
    scopedKey(
      CacheKey.OpenAppaHitlReviewHistory,
      params.session,
      JSON.stringify([params.callId, params.offerId]),
    ),
    { throwOnError: true },
  );
  if (record?.callId !== params.callId || record.offerId !== params.offerId)
    return undefined;
  // Previously issued review-required facts did not carry an outcome.
  return record.outcome ?? "review_required";
}

export async function getHitlReview(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<PendingHitlReview | undefined> {
  // A review that cannot be read is not a review that is gone: callers turn
  // its absence into a closed question, so a storage failure must fail them.
  const review = await cacheManager.get<PendingHitlReview>(
    reviewKey(params.session, params.offerId),
    { throwOnError: true },
  );
  if (review?.offerId === params.offerId) return review;
  // Native clients still need the exact review text to bind their following
  // remedy call. This immutable context is not a claimable pending stage.
  if ((await peekHitlRuling(params)) !== "approve") return undefined;
  const approved = await cacheManager.get<PendingHitlReview>(
    stagePresenceKey(params.session, params.offerId),
    { throwOnError: true },
  );
  return approved?.offerId === params.offerId ? approved : undefined;
}

type HitlDecision = {
  ruling: HitlRuling;
  closure?: HitlClosureReason;
};

/**
 * Observe a human ruling without spending the remedy's one-time approval.
 * @internal exported for tests
 */
export async function peekHitlRuling(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<HitlRuling | undefined> {
  return (await peekHitlDecision(params))?.ruling;
}

/**
 * Observe the stored decision, including a non-ruling closure.
 * Priority is deny, then approve, then none. A none entry written before this
 * change has no closure; that absence is not a denial.
 */
export async function peekHitlDecision(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<HitlDecision | undefined> {
  for (const ruling of ["deny", "approve", "none"] as const) {
    const entry = await cacheManager.get<StoredRuling>(
      rulingKey(params.session, params.offerId, ruling),
      { throwOnError: true },
    );
    if (entry?.offerId !== params.offerId || entry.ruling !== ruling) continue;
    const closure = closureOf(entry);
    return closure ? { ruling, closure } : { ruling };
  }
  return undefined;
}

export async function getHitlAskUserArguments(params: {
  session: OpenAppaSession;
  offerIds: readonly string[];
}): Promise<HitlAskUserArguments | undefined> {
  if (params.offerIds.length !== 1) return undefined;
  const offerId = params.offerIds[0];
  const review = await getHitlReview({ session: params.session, offerId });
  if (!review) return undefined;
  return buildHitlAskUserCard(review);
}

/**
 * The review as one card: the call by the name the user knows it under, its
 * arguments as named values, and what an approval accepts besides the
 * person's attention, such as a wider audience. Where the coverage is not in
 * the shape read here, the full text is shown and nothing it covers is left
 * out.
 */
function buildHitlAskUserCard(review: PendingHitlReview): HitlAskUserArguments {
  const offerId = review.offerId;
  const options = [
    { label: "Approve", description: "Allow this exact tool call." },
    { label: "Deny", description: "Keep this tool call blocked." },
  ];
  if (!review.tool) {
    return {
      question: formatReviewQuestion(review.text),
      header: "Approval",
      options,
      allowMultiple: false,
      remedy_offer_ids: [offerId],
    };
  }
  // Claude Code shows the call in full in each option's preview and asks one
  // line about it. Where it would withhold that preview, and on forms and
  // other hosts, the question itself carries the exact call and what an
  // approval accepts besides it.
  const parsed = parseReviewedArguments(review.arguments);
  if (review.arguments && !parsed) {
    return {
      question: `${formatReviewQuestion(review.text)}\n\nExact arguments (unparsed):\n${review.arguments}`,
      header: "Approval",
      options,
      allowMultiple: false,
      remedy_offer_ids: [offerId],
    };
  }
  const args = withoutCommandAlias(review.tool, parsed ?? {});
  const accepted = acceptedCoverage(review.text);
  const preview = callPreview(review.tool, args);
  return {
    question:
      approvalQuestion({
        tool: review.tool,
        args,
        accepted,
        summary: review.summary,
      }) ??
      [...summaryBlock(review.summary), formatReviewQuestion(review.text)].join(
        "\n\n",
      ),
    shortQuestion: `Approve the ${preview.subject}?`,
    callPreview: previewText({ preview, accepted, summary: review.summary }),
    header: "Approval",
    options,
    allowMultiple: false,
    remedy_offer_ids: [offerId],
  };
}

/**
 * The inspectable card for a review: the ordinary card with an "Inspect
 * details" option, or — when the plain card cannot show the review — the
 * compact overview card. When a signed Inspect answer is still pending, the
 * card carries the complete review text for the transport to place above
 * it; the pending state is not consumed here, only when an answer to that
 * very card comes back. Returns undefined when the review is already ruled
 * on, so the caller falls back to the ordinary card.
 */
export async function getHitlInspectableAskUserArguments(params: {
  session: OpenAppaSession;
  offerIds: readonly string[];
  /** Render the complete review text when an inspection is pending. */
  emit?: boolean;
}): Promise<
  | {
      card: HitlAskUserArguments;
      /** The staged payload this card is issued from; rides its claim. */
      digest: string;
      reviewText?: string;
    }
  | undefined
> {
  if (params.offerIds.length !== 1) return undefined;
  const offerId = params.offerIds[0];
  const review = await getHitlReview({ session: params.session, offerId });
  if (!review) return undefined;
  const base = buildHitlAskUserCard(review);
  const digest = hitlInspectionDigest(review);
  const outcome = await cacheManager.withLock(
    stagePresenceKey(params.session, offerId),
    async (cache) => {
      // A review that already has its answer offers no further inspection.
      const rulings = await readLockedRulings(cache, params.session, offerId);
      if (rulings.deny || rulings.approve || rulings.none)
        return { closed: true as const };
      const staged = await cache.get<PendingHitlReview>(
        stagePresenceKey(params.session, offerId),
      );
      if (staged?.offerId !== offerId) return { closed: true as const };
      if (hitlInspectionDigest(staged) !== digest)
        return { closed: true as const };
      const stored = hitlInspectionOf(
        await cache.get<StoredHitlInspection>(
          inspectionKey(params.session, offerId),
        ),
        offerId,
      );
      if (stored && stored.digest !== digest) {
        // A re-staged review renders differently: a past inspection no
        // longer describes it.
        await cache.delete(inspectionKey(params.session, offerId));
        return { inspection: undefined };
      }
      return { inspection: stored };
    },
  );
  if ("closed" in outcome) return undefined;
  const card = needsHitlReviewInspection(base)
    ? hitlReviewOverviewCard({ base, review }).card
    : withInspectDetailsOption(base);
  const reviewText =
    params.emit !== false && outcome.inspection?.status === "pending"
      ? renderHitlReviewText(review)
      : undefined;
  return { card, digest, ...(reviewText ? { reviewText } : {}) };
}

/**
 * Reads the answer to an inspectable card atomically with the inspection
 * state, binding the answer to the exact staged payload the answered card
 * was issued from: a card issued before a re-stage is stale and rules
 * nothing, and only a matching claim carrying the review-text marker proves
 * the client received that payload's complete review. An answer whose claim
 * carries the marker moves a pending inspection to delivered before it is
 * read — the text precedes the card in the same response, so receiving the
 * card is receiving the text. Approve records only for a matching claim with
 * no undelivered inspection outstanding, and only when the card could carry
 * an approval at all; Deny records on any matching card; Inspect marks the
 * review pending (or reports the text already shown). Nothing here retries
 * or grants on a stale claim.
 */
export async function resolveHitlInspectableAnswer(params: {
  session: OpenAppaSession;
  offerId: string;
  answer: "approve" | "deny" | "inspect";
  /** The answered card was issued with the complete review text above it. */
  carriedReviewText: boolean;
  /** The payload digest the answered card was issued with. */
  claimDigest: string;
}): Promise<
  | { status: "recorded"; ruling: "approve" | "deny" }
  | { status: "inspect-pending" | "inspect-shown" }
  | { status: "stale" }
  | { status: "closed" }
> {
  const { session, offerId } = params;
  const outcome = await cacheManager.withLock(
    stagePresenceKey(session, offerId),
    async (cache) => {
      const existing = await readLockedRulings(cache, session, offerId);
      if (existing.deny || existing.approve || existing.none)
        return { status: "closed" as const };
      const staged = await cache.get<PendingHitlReview>(
        stagePresenceKey(session, offerId),
      );
      if (staged?.offerId !== offerId) return { status: "closed" as const };
      const digest = hitlInspectionDigest(staged);
      // The answered card must be this payload's card: an answer to a card
      // issued before a re-stage rules nothing, whatever label it carries.
      if (params.claimDigest !== digest) return { status: "stale" as const };
      let inspection = hitlInspectionOf(
        await cache.get<StoredHitlInspection>(inspectionKey(session, offerId)),
        offerId,
      );
      if (inspection && inspection.digest !== digest) {
        // The staged payload changed since the inspection; it describes a
        // review that is no longer offered.
        await cache.delete(inspectionKey(session, offerId));
        inspection = undefined;
      }
      // A card issued with the review text places that text before the card
      // in the same response; only a client that received it can answer it.
      // The transition is local: on the ruling paths below the inspection
      // record is deleted atomically with the ruling in this same lock, and
      // on the Inspect path it is persisted explicitly. No delivered state
      // can be observed without one of those writes.
      if (params.carriedReviewText && inspection?.status === "pending") {
        inspection = { ...inspection, status: "delivered" as const };
      }
      if (params.answer === "inspect") {
        if (inspection?.status === "delivered") {
          await cache.set(
            inspectionKey(session, offerId),
            { offerId, ...inspection },
            HITL_REVIEW_TTL_MS,
          );
          return { status: "inspect-shown" as const };
        }
        await cache.set(
          inspectionKey(session, offerId),
          { offerId, digest, status: "pending" as const },
          HITL_REVIEW_TTL_MS,
        );
        return { status: "inspect-pending" as const };
      }
      // No approval while a requested inspection has not been delivered:
      // the reviewer asked to read the complete review first.
      if (params.answer === "approve" && inspection?.status === "pending") {
        return { status: "stale" as const };
      }
      if (params.answer === "approve") {
        const base = buildHitlAskUserCard(staged);
        const approvable =
          !needsHitlReviewInspection(base) ||
          hitlReviewOverviewCard({ base, review: staged }).approve;
        if (!approvable) return { status: "stale" as const };
      }
      const pending = await cache.getAndDelete<PendingHitlReview>(
        reviewKey(session, offerId),
      );
      // A denial stands even when the spendable stage is already gone; an
      // approval requires it.
      if (pending?.offerId !== offerId && params.answer === "approve") {
        return { status: "closed" as const };
      }
      await cache.delete(inspectionKey(session, offerId));
      await cache.set(
        rulingKey(session, offerId, params.answer),
        { offerId, ruling: params.answer },
        HITL_REVIEW_TTL_MS,
      );
      if (params.answer === "deny") {
        await cache.delete(rulingKey(session, offerId, "approve"));
        await cache.delete(rulingKey(session, offerId, "none"));
      } else {
        await cache.delete(rulingKey(session, offerId, "none"));
      }
      return { status: "recorded" as const, ruling: params.answer };
    },
  );
  if (outcome.status === "recorded") {
    logger.info(
      {
        sessionId: session.session_id,
        callerId: session.caller_id,
        ruling: outcome.ruling,
      },
      "OpenAPPA human-review ruling recorded",
    );
  }
  return outcome;
}

export async function recordHitlRuling(params: {
  session: OpenAppaSession;
  offerId: string;
  ruling: HitlRuling;
  closure?: HitlClosureReason;
}): Promise<boolean> {
  const recorded = await cacheManager.withLock(
    stagePresenceKey(params.session, params.offerId),
    async (cache) => {
      // Validation and commit share the consumer's lock across replicas.
      const issued = await cache.get<PendingHitlReview>(
        stagePresenceKey(params.session, params.offerId),
      );
      if (issued?.offerId !== params.offerId) return false;
      const existing = await readLockedRulings(
        cache,
        params.session,
        params.offerId,
      );
      // deny > approve > none. A closure cannot erase either human ruling.
      if (params.ruling === "none" && (existing.deny || existing.approve)) {
        return false;
      }
      if (params.ruling === "approve" && (existing.deny || existing.approve)) {
        return false;
      }
      const pending = await cache.getAndDelete<PendingHitlReview>(
        reviewKey(params.session, params.offerId),
      );
      const pendingOk = pending?.offerId === params.offerId;
      // A genuine later denial can revoke an unspent approval. An approval can
      // replace a closure that has not been sealed. A closure cannot.
      if (
        !pendingOk &&
        params.ruling !== "deny" &&
        !(params.ruling === "approve" && existing.none && !existing.deny)
      ) {
        return false;
      }
      const closure =
        params.ruling === "none"
          ? (params.closure ?? closureOf(existing.none))
          : undefined;
      await cache.set(
        rulingKey(params.session, params.offerId, params.ruling),
        {
          offerId: params.offerId,
          ruling: params.ruling,
          ...(closure ? { closure } : {}),
        },
        HITL_REVIEW_TTL_MS,
      );
      if (params.ruling === "deny") {
        await cache.delete(
          rulingKey(params.session, params.offerId, "approve"),
        );
        await cache.delete(rulingKey(params.session, params.offerId, "none"));
      } else if (params.ruling === "approve") {
        await cache.delete(rulingKey(params.session, params.offerId, "none"));
        // The review an approval is spent with lives as long as the approval:
        // the proxy reads it to make the remedy call the approval authorizes.
        await cache.set(
          stagePresenceKey(params.session, params.offerId),
          issued,
          HITL_REVIEW_TTL_MS,
        );
      }
      return true;
    },
  );
  if (!recorded) return false;
  logger.info(
    {
      sessionId: params.session.session_id,
      callerId: params.session.caller_id,
      ruling: params.ruling,
      ...(params.closure ? { closure: params.closure } : {}),
    },
    params.ruling === "none"
      ? "OpenAPPA review closed without a human ruling"
      : "OpenAPPA human-review ruling recorded",
  );
  return true;
}

/**
 * Keeps a staged review for the question a client now shows about it. The
 * review outlives the question by a full review window, so an answer the
 * question still accepts always finds the review it is read against. A review
 * that is not staged, or already ruled or closed, is left as it is.
 */
export async function renewHitlReview(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<boolean> {
  return cacheManager.withLock(
    stagePresenceKey(params.session, params.offerId),
    async (cache) => {
      const issued = await cache.get<PendingHitlReview>(
        stagePresenceKey(params.session, params.offerId),
      );
      const pending = await cache.get<PendingHitlReview>(
        reviewKey(params.session, params.offerId),
      );
      if (
        issued?.offerId !== params.offerId ||
        pending?.offerId !== params.offerId
      )
        return false;
      const existing = await readLockedRulings(
        cache,
        params.session,
        params.offerId,
      );
      if (existing.deny || existing.approve || existing.none) return false;
      const lifetime = HITL_QUESTION_TTL_MS + HITL_REVIEW_TTL_MS;
      await cache.set(
        stagePresenceKey(params.session, params.offerId),
        issued,
        lifetime,
      );
      await cache.set(
        reviewKey(params.session, params.offerId),
        pending,
        lifetime,
      );
      return true;
    },
  );
}

/**
 * Record a terminal non-ruling and drop the live stage so the next remedy
 * call cannot open another question. A human ruling already in the lock wins
 * and is left in place.
 */
export async function sealHitlClosure(params: {
  session: OpenAppaSession;
  offerId: string;
  closure?: HitlClosureReason;
}): Promise<"approve" | "deny" | "sealed"> {
  const sealed = await cacheManager.withLock(
    stagePresenceKey(params.session, params.offerId),
    async (cache) => {
      const existing = await readLockedRulings(
        cache,
        params.session,
        params.offerId,
      );
      if (existing.deny) return "deny" as const;
      if (existing.approve) return "approve" as const;
      const closure = params.closure ?? closureOf(existing.none);
      await cache.set(
        rulingKey(params.session, params.offerId, "none"),
        {
          offerId: params.offerId,
          ruling: "none" as const,
          ...(closure ? { closure } : {}),
        },
        HITL_REVIEW_TTL_MS,
      );
      await cache.delete(reviewKey(params.session, params.offerId));
      await cache.delete(stagePresenceKey(params.session, params.offerId));
      await cache.delete(inspectionKey(params.session, params.offerId));
      return "sealed" as const;
    },
  );
  if (sealed === "sealed") {
    logger.info(
      {
        sessionId: params.session.session_id,
        callerId: params.session.caller_id,
        closure: params.closure,
      },
      "OpenAPPA review closed without a human ruling",
    );
  }
  return sealed;
}

export async function consumeHitlRuling(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<HitlRuling | undefined> {
  return cacheManager.withLock(
    stagePresenceKey(params.session, params.offerId),
    async (cache) => {
      const keys = HITL_RULINGS.map((ruling) =>
        rulingKey(params.session, params.offerId, ruling),
      );
      const entries = new Map(
        (
          await cache.getAndDeleteMany<{
            offerId?: unknown;
            ruling?: unknown;
          }>(keys)
        ).map((entry) => [entry.key, entry.value]),
      );
      const recorded = HITL_RULINGS.filter((ruling) => {
        const entry = entries.get(
          rulingKey(params.session, params.offerId, ruling),
        );
        return entry?.offerId === params.offerId && entry.ruling === ruling;
      });
      const selected = recorded.includes("deny")
        ? "deny"
        : recorded.includes("approve")
          ? "approve"
          : recorded.includes("none")
            ? "none"
            : undefined;
      if (!selected) return undefined;
      await cache.delete(reviewKey(params.session, params.offerId));
      await cache.delete(stagePresenceKey(params.session, params.offerId));
      await cache.delete(inspectionKey(params.session, params.offerId));
      // A closure is not spent. Put it back so the next remedy call still
      // fails closed instead of opening another question.
      if (selected === "none") {
        const entry = entries.get(
          rulingKey(params.session, params.offerId, "none"),
        );
        if (entry) {
          await cache.set(
            rulingKey(params.session, params.offerId, "none"),
            entry,
            HITL_REVIEW_TTL_MS,
          );
        }
      }
      return selected;
    },
  );
}

export async function clearHitlReview(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<void> {
  await cacheManager.withLock(
    stagePresenceKey(params.session, params.offerId),
    async (cache) => {
      await cache.getAndDeleteMany([
        reviewKey(params.session, params.offerId),
        stagePresenceKey(params.session, params.offerId),
        inspectionKey(params.session, params.offerId),
        ...HITL_RULINGS.map((ruling) =>
          rulingKey(params.session, params.offerId, ruling),
        ),
      ]);
    },
  );
}

/**
 * Asks a pending review once more through the gateway's MCP form, where the
 * choice comes back as data. For an answer the proxy could not read.
 */
export async function askHitlReviewInForm(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<void> {
  await cacheManager.set(
    formKey(params.session, params.offerId),
    { offerId: params.offerId },
    HITL_REVIEW_TTL_MS,
  );
}

export async function hitlReviewAskedInForm(params: {
  session: OpenAppaSession;
  offerIds: readonly string[];
}): Promise<boolean> {
  for (const offerId of params.offerIds) {
    const entry = await cacheManager.get<{ offerId: string }>(
      formKey(params.session, offerId),
      { throwOnError: true },
    );
    if (entry?.offerId === offerId) return true;
  }
  return false;
}

export function hitlRulingFromLabels(
  labels: readonly string[],
): HitlRuling | undefined {
  if (labels.length !== 1) return undefined;
  if (labels[0] === "Approve") return "approve";
  if (labels[0] === "Deny") return "deny";
  return undefined;
}

function approvalQuestion(params: {
  tool: string;
  args: Record<string, unknown>;
  accepted: string[] | undefined;
  summary?: string;
}): string | undefined {
  if (!params.accepted) return undefined;
  const needsBlock = Object.values(params.args).some(
    (value) =>
      typeof value === "string" &&
      (value.length > 1000 || value.includes("\n")),
  );
  const argumentLines = needsBlock
    ? `Full arguments (YAML, not summarized):\n${dumpYaml(params.args, { lineWidth: -1, noRefs: true }).trimEnd()}`
    : formatArgumentLines(params.args);
  return [
    `Approve ${reviewedToolLabel(params.tool)}?`,
    // Native clients can truncate long questions; show review coverage first.
    ...acceptedBlock(params.accepted),
    ...summaryBlock(params.summary),
    ...(argumentLines ? [argumentLines] : []),
    "Approve lets this exact call run. Deny keeps it blocked.",
  ].join("\n\n");
}

/**
 * What an approval accepts besides the person's attention, or undefined when
 * the review text's coverage is not in the shape read here.
 */
function acceptedCoverage(text: string): string[] | undefined {
  return reviewCoverage(text)?.filter(
    (line) => !line.startsWith("attention: "),
  );
}

function acceptedBlock(accepted: string[] | undefined): string[] {
  if (!accepted || accepted.length === 0) return [];
  return [
    ["Approving also accepts:", ...accepted.map((line) => `  - ${line}`)].join(
      "\n",
    ),
  ];
}

function summaryBlock(summary: string | undefined): string[] {
  return summary
    ? [
        `Generated summary (may omit details; the full call below is authoritative):\n${summary}`,
      ]
    : [];
}

/**
 * The proxy evaluates command tools with `command` and `cmd` set to one value,
 * so policies match either spelling. The reviewer sees that value once.
 */
function withoutCommandAlias(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isCommandExecutionTool(tool) || args.cmd !== args.command) return args;
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => name !== "cmd"),
  );
}

/** The runtime's "What this ruling would cover" lines, or undefined. */
function reviewCoverage(text: string): string[] | undefined {
  const lines = text.split("\n");
  const start = lines.indexOf(COVERAGE_HEADING);
  if (start < 0) return undefined;
  const coverage: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "") return coverage;
    if (line === "  (none)") continue;
    if (!line.startsWith("  - ")) return undefined;
    coverage.push(line.slice("  - ".length));
  }
  return coverage;
}

const COVERAGE_HEADING = "What this ruling would cover:";

/** Shown under the title: a command's description, or the file a call writes. */
type CallPreview = { subject: string; summary?: string; body: string[] };

/**
 * The reviewed call as Claude Code previews it beside the choices: a title
 * naming the call, the call in full, and what an approval also accepts. The
 * pane neither wraps nor fits long lines, so every line is wrapped to it.
 */
function previewText(params: {
  preview: CallPreview;
  accepted: string[] | undefined;
  summary?: string;
}): string {
  const { subject, summary, body } = params.preview;
  const accepted = params.accepted ?? [];
  const heading = [
    ...wrapText(subject).map((line) => `**${escapeMarkdown(line)}**`),
    ...(summary
      ? wrapText(summary).map((line) => `*${escapeMarkdown(line)}*`)
      : []),
  ];
  return [
    heading.join("\n"),
    ...summaryBlock(params.summary).map(escapeMarkdown),
    ...body,
    ...(accepted.length > 0
      ? [
          [
            "Approving also accepts:",
            ...accepted.flatMap((line) => wrapText(line, "• ", "  ")),
          ]
            .map(escapeMarkdown)
            .join("\n"),
        ]
      : []),
  ].join("\n\n");
}

/**
 * The call in the form a person reads it in: a command as it runs, a file
 * write as the file's content, an edit as a diff, and any other call as its
 * arguments in YAML. Nothing is shortened.
 */
function callPreview(tool: string, args: Record<string, unknown>): CallPreview {
  const label = reviewedToolLabel(tool);
  const baseName = tool.replace(/^(builtin:|host\/[^/]+\/)/, "");
  const { command, description, file_path, content, old_string, new_string } =
    args;
  if (isCommandExecutionTool(tool) && typeof command === "string") {
    const summary =
      typeof description === "string"
        ? description.replace(/\s+/g, " ").trim()
        : "";
    return {
      subject: `${label} command`,
      ...(summary ? { summary } : {}),
      body: [
        codeBlock(wrapCode(command), "sh"),
        ...argumentsBlock(
          without(args, summary ? ["command", "description"] : ["command"]),
        ),
      ],
    };
  }
  const subject = `${label} call`;
  if (typeof file_path === "string") {
    if (baseName === "Write" && typeof content === "string")
      return {
        subject,
        summary: file_path,
        body: [
          codeBlock(wrapCode(content), languageOf(file_path)),
          ...argumentsBlock(without(args, ["file_path", "content"])),
        ],
      };
    if (
      baseName === "Edit" &&
      typeof old_string === "string" &&
      typeof new_string === "string"
    )
      return {
        subject,
        summary: file_path,
        body: [
          codeBlock(wrapCode(diff(old_string, new_string), true), "diff"),
          ...argumentsBlock(
            without(args, ["file_path", "old_string", "new_string"]),
          ),
        ],
      };
    const edits = args.edits;
    if (baseName === "MultiEdit" && Array.isArray(edits) && edits.every(isEdit))
      return {
        subject,
        summary: file_path,
        body: [
          ...edits.map((edit) =>
            codeBlock(
              wrapCode(diff(edit.old_string, edit.new_string), true),
              "diff",
            ),
          ),
          ...argumentsBlock(without(args, ["file_path", "edits"])),
        ],
      };
  }
  const body = argumentsBlock(args);
  return {
    subject,
    body: body.length > 0 ? body : ["This call has no arguments."],
  };
}

/**
 * Code wrapped to the preview pane. A wrapped line breaks at a space where it
 * can and continues four spaces further in, so it does not read as a new
 * line; a diff line keeps its sign.
 */
function wrapCode(text: string, diffLines = false): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const lead = (diffLines ? /^[+-]?\s*/ : /^\s*/).exec(line)?.[0] ?? "";
      // Past half the pane, the indent would leave too little room for the
      // value; such a line continues four spaces in from the margin instead.
      const continuation =
        lead.length + 4 <= PREVIEW_WIDTH / 2
          ? `${lead}    `
          : `${diffLines ? lead.slice(0, 1) : ""}    `;
      return wrapLine({ line, lead: lead.length, continuation });
    })
    .join("\n");
}

/** Text on as few pane-wide lines as it takes, after `first`, under `rest`. */
function wrapText(text: string, first = "", rest = ""): string[] {
  return wrapLine({
    line: `${first}${text.replace(/\s+/g, " ").trim()}`,
    lead: first.length,
    continuation: rest,
  });
}

function wrapLine(params: {
  line: string;
  /** Characters at the start that a break must not split. */
  lead: number;
  continuation: string;
}): string[] {
  const lines: string[] = [];
  let rest = params.line;
  let floor = params.lead;
  while (rest.length > PREVIEW_WIDTH) {
    const space = rest.lastIndexOf(" ", PREVIEW_WIDTH);
    const cut = space > floor ? space : PREVIEW_WIDTH;
    lines.push(rest.slice(0, cut));
    rest = `${params.continuation}${rest.slice(cut === space ? cut + 1 : cut)}`;
    floor = params.continuation.length;
  }
  lines.push(rest);
  return lines;
}

/**
 * Columns of Claude Code's narrowest preview pane: VS Code beside the option
 * list at its 576px breakpoint, with the default 14px editor font. The pane
 * cuts longer lines.
 */
const PREVIEW_WIDTH = 34;

/** The arguments as YAML in a block, or nothing when there are none. */
function argumentsBlock(args: Record<string, unknown>): string[] {
  if (Object.keys(args).length === 0) return [];
  // No YAML folding: wrapCode marks its own continuation lines.
  return [
    codeBlock(
      wrapCode(dumpYaml(args, { lineWidth: -1, noRefs: true }).trimEnd()),
      "yaml",
    ),
  ];
}

function without(
  args: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => !names.includes(name)),
  );
}

function isEdit(
  value: unknown,
): value is { old_string: string; new_string: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).old_string === "string" &&
    typeof (value as Record<string, unknown>).new_string === "string"
  );
}

/** The replaced lines with "-", the new ones with "+". */
function diff(before: string, after: string): string {
  return [
    ...before.split("\n").map((line) => `-${line}`),
    ...after.split("\n").map((line) => `+${line}`),
  ].join("\n");
}

/** A code block language from the file's extension, for highlighting only. */
function languageOf(path: string): string {
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1];
  return extension ? extension.toLowerCase() : "text";
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>#~|]/g, "\\$&");
}

/**
 * The text as a fenced block. Claude Code renders previews as markdown, so
 * outside a block it would drop the `**`, `__` and backticks of a reviewed
 * command. The fence is longer than any backtick run in the text, so the
 * text cannot end the block early.
 */
function codeBlock(text: string, language = "text"): string {
  const longestRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function formatReviewQuestion(text: string): string {
  // Native question renderers fold/indent rows independently, breaking pixel art.
  // Replace only the runtime's decorative prefix, never the reviewed payload.
  return text.startsWith(PIXEL_REVIEW_HEADING)
    ? `[OpenAPPA] Approve this call?\n${text.slice(PIXEL_REVIEW_HEADING.length)}`
    : text;
}

const PIXEL_REVIEW_HEADING =
  "\u2584\u2588\u2584\u2584\u2584\u2588\u2584  \u2580\u2580\u2588  Approve this call?\n" +
  "\u2588\u2588\u2584\u2588\u2584\u2588\u2588   \u2584   ";

type StoredRuling = {
  offerId?: unknown;
  ruling?: unknown;
  // Cache JSON is untrusted until closureOf checks the closed set.
  closure?: unknown;
};

type LockedCache = Parameters<Parameters<typeof cacheManager.withLock>[1]>[0];

function closureOf(
  entry: StoredRuling | undefined,
): HitlClosureReason | undefined {
  return isHitlClosureReason(entry?.closure) ? entry.closure : undefined;
}

/**
 * Reads the three ruling slots inside the caller's lock. Locked reads run as
 * raw SQL in the lock's transaction and decode with JSON.parse, so a storage
 * or decode failure throws and rolls the transaction back: an unreadable
 * ruling — a deny above all — fails closed instead of reading as absent.
 * There is deliberately no silent-miss option on the locked cache.
 */
async function readLockedRulings(
  cache: LockedCache,
  session: OpenAppaSession,
  offerId: string,
): Promise<{
  deny?: StoredRuling;
  approve?: StoredRuling;
  none?: StoredRuling;
}> {
  const read = async (ruling: HitlRuling) => {
    const entry = await cache.get<StoredRuling>(
      rulingKey(session, offerId, ruling),
    );
    return entry?.offerId === offerId && entry.ruling === ruling
      ? entry
      : undefined;
  };
  return {
    deny: await read("deny"),
    approve: await read("approve"),
    none: await read("none"),
  };
}

function stagePresenceKey(
  session: OpenAppaSession,
  offerId: string,
): AllowedCacheKey {
  return scopedKey(
    CacheKey.OpenAppaHitlRuling,
    session,
    `${offerId}:stage-presence`,
  );
}

function formKey(session: OpenAppaSession, offerId: string): AllowedCacheKey {
  return scopedKey(CacheKey.OpenAppaHitlRuling, session, `${offerId}:form`);
}

/** The inspection state of an inspectable native review, beside its rulings. */
function inspectionKey(
  session: OpenAppaSession,
  offerId: string,
): AllowedCacheKey {
  return scopedKey(CacheKey.OpenAppaHitlRuling, session, `${offerId}:inspect`);
}

type StoredHitlInspection = {
  offerId?: unknown;
  digest?: unknown;
  status?: unknown;
};

type HitlInspection = {
  digest: string;
  status: HitlInspectionStatus;
};

/** A cached inspection state, or undefined when the stored value is not one. */
function hitlInspectionOf(
  entry: StoredHitlInspection | undefined,
  offerId: string,
): HitlInspection | undefined {
  if (entry?.offerId !== offerId) return undefined;
  const { digest, status } = entry;
  if (typeof digest !== "string" || digest.length === 0) return undefined;
  if (status !== "pending" && status !== "delivered") return undefined;
  return { digest, status };
}

function reviewKey(session: OpenAppaSession, offerId: string): AllowedCacheKey {
  return scopedKey(CacheKey.OpenAppaHitlReview, session, offerId);
}

function rulingKey(
  session: OpenAppaSession,
  offerId: string,
  ruling: HitlRuling,
): AllowedCacheKey {
  return scopedKey(
    CacheKey.OpenAppaHitlRuling,
    session,
    `${offerId}:${ruling}`,
  );
}

function scopedKey(
  prefix:
    | typeof CacheKey.OpenAppaHitlReview
    | typeof CacheKey.OpenAppaHitlRuling
    | typeof CacheKey.OpenAppaHitlReviewHistory,
  session: OpenAppaSession,
  offerId: string,
): AllowedCacheKey {
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        session.organization_id,
        session.caller_id ?? "",
        session.session_id,
        session.parent_id ?? "",
        offerId,
      ]),
    )
    .digest("base64url");
  return `${prefix}-${scope}`;
}
