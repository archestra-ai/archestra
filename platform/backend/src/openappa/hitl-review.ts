import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { parseWorkloadPrincipal } from "@/services/agent-runtime/runtime-identity";
import { sessionCallerId } from "./actor";
import type { OpenAppaSession } from "./service";

type HitlRuling = "approve" | "deny" | "none";

export type HitlReviewOutcome =
  | "review_required"
  | "review_unanswered"
  | "review_cancelled"
  | "review_unavailable"
  | "review_invalid";

type PendingHitlReview = {
  offerId: string;
  text: string;
  tool?: string;
  arguments?: string;
  remedyArguments?: Record<string, unknown>;
};

type HitlAskUserArguments = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  allowMultiple: false;
  remedy_offer_ids: [string];
};

const HITL_REVIEW_TTL_MS = 10 * TimeInMs.Minute;
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
}): Promise<void> {
  await cacheManager.withLock(
    stagePresenceKey(params.session, params.review.offerId),
    async (cache) => {
      await cache.set(
        stagePresenceKey(params.session, params.review.offerId),
        params.review,
        HITL_REVIEW_TTL_MS,
      );
      await cache.set(
        reviewKey(params.session, params.review.offerId),
        params.review,
        HITL_REVIEW_TTL_MS,
      );
    },
  );
  if (params.callId) {
    await recordHitlReviewResult({
      session: params.session,
      callId: params.callId,
      offerId: params.review.offerId,
      outcome: "review_required",
    });
  }
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
  const review = await cacheManager.get<PendingHitlReview>(
    reviewKey(params.session, params.offerId),
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

/** Observe a human ruling without spending the remedy's one-time approval. */
export async function peekHitlRuling(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<HitlRuling | undefined> {
  for (const ruling of ["deny", "none", "approve"] as const) {
    const entry = await cacheManager.get<{
      offerId: string;
      ruling: HitlRuling;
    }>(rulingKey(params.session, params.offerId, ruling), {
      throwOnError: true,
    });
    if (entry?.offerId === params.offerId && entry.ruling === ruling)
      return ruling;
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
  return {
    question: formatReviewQuestion(review.text),
    header: "Approval",
    options: [
      {
        label: "Approve",
        description: "Allow this exact tool call.",
      },
      {
        label: "Deny",
        description: "Keep this tool call blocked.",
      },
    ],
    allowMultiple: false,
    remedy_offer_ids: [offerId],
  };
}

export async function recordHitlRuling(params: {
  session: OpenAppaSession;
  offerId: string;
  ruling: HitlRuling;
}): Promise<boolean> {
  const recorded = await cacheManager.withLock(
    stagePresenceKey(params.session, params.offerId),
    async (cache) => {
      // Validation and commit share the consumer's lock across replicas.
      const issued = await cache.get<{ offerId: string }>(
        stagePresenceKey(params.session, params.offerId),
      );
      if (issued?.offerId !== params.offerId) return false;
      const pending = await cache.getAndDelete<PendingHitlReview>(
        reviewKey(params.session, params.offerId),
      );
      // A genuine later denial can revoke an unspent approval; a timeout cannot.
      if (pending?.offerId !== params.offerId && params.ruling !== "deny")
        return false;
      await cache.set(
        rulingKey(params.session, params.offerId, params.ruling),
        { offerId: params.offerId, ruling: params.ruling },
        HITL_REVIEW_TTL_MS,
      );
      if (params.ruling !== "approve") {
        await cache.delete(
          rulingKey(params.session, params.offerId, "approve"),
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
    },
    "OpenAPPA human-review ruling recorded",
  );
  return true;
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
        : recorded.includes("none")
          ? "none"
          : recorded.includes("approve")
            ? "approve"
            : undefined;
      if (!selected) return undefined;
      await cache.delete(reviewKey(params.session, params.offerId));
      await cache.delete(stagePresenceKey(params.session, params.offerId));
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
        ...HITL_RULINGS.map((ruling) =>
          rulingKey(params.session, params.offerId, ruling),
        ),
      ]);
    },
  );
}

export function hitlRulingFromLabels(
  labels: readonly string[],
): HitlRuling | undefined {
  if (labels.length !== 1) return undefined;
  if (labels[0] === "Approve") return "approve";
  if (labels[0] === "Deny") return "deny";
  return undefined;
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
