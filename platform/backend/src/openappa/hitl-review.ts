import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import type { OpenAppaSession } from "./service";

type HitlRuling = "approve" | "deny" | "none";

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
const HITL_RULINGS: readonly HitlRuling[] = ["approve", "none", "deny"];

export async function stageHitlReview(params: {
  session: OpenAppaSession;
  review: PendingHitlReview;
}): Promise<void> {
  // Remember issuance before making the stage visible, so concurrent denial can
  // veto an approval while its atomic claimant is committing the ruling.
  await cacheManager.set(
    stagePresenceKey(params.session, params.review.offerId),
    { offerId: params.review.offerId },
    HITL_REVIEW_TTL_MS,
  );
  await cacheManager.set(
    reviewKey(params.session, params.review.offerId),
    params.review,
    HITL_REVIEW_TTL_MS,
  );
}

export async function getHitlReview(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<PendingHitlReview | undefined> {
  const review = await cacheManager.get<PendingHitlReview>(
    reviewKey(params.session, params.offerId),
  );
  return review?.offerId === params.offerId ? review : undefined;
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
    question: review.text,
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
  const pending = await cacheManager.getAndDelete<PendingHitlReview>(
    reviewKey(params.session, params.offerId),
    { throwOnError: true },
  );
  if (pending?.offerId !== params.offerId) {
    // A genuine later denial can revoke an unspent approval; a timeout cannot.
    const issued = await cacheManager.get<{ offerId: string }>(
      stagePresenceKey(params.session, params.offerId),
      { throwOnError: true },
    );
    if (params.ruling !== "deny" || issued?.offerId !== params.offerId)
      return false;
  }
  await cacheManager.set(
    rulingKey(params.session, params.offerId, params.ruling),
    { offerId: params.offerId, ruling: params.ruling },
    HITL_REVIEW_TTL_MS,
  );
  if (params.ruling !== "approve") {
    await cacheManager.delete(
      rulingKey(params.session, params.offerId, "approve"),
    );
  }
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
  const keys = HITL_RULINGS.map((ruling) =>
    rulingKey(params.session, params.offerId, ruling),
  );
  const entries = new Map(
    (
      await cacheManager.getAndDeleteMany<{
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
  await cacheManager.delete(reviewKey(params.session, params.offerId));
  if (selected)
    await cacheManager.delete(
      stagePresenceKey(params.session, params.offerId),
      { throwOnError: true },
    );
  return selected;
}

export async function clearHitlReview(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<void> {
  await Promise.all([
    cacheManager.delete(reviewKey(params.session, params.offerId)),
    cacheManager.delete(stagePresenceKey(params.session, params.offerId)),
    ...HITL_RULINGS.map((ruling) =>
      cacheManager.delete(rulingKey(params.session, params.offerId, ruling)),
    ),
  ]);
}

export function hitlRulingFromLabels(
  labels: readonly string[],
): HitlRuling | undefined {
  if (labels.length !== 1) return undefined;
  if (labels[0] === "Approve") return "approve";
  if (labels[0] === "Deny") return "deny";
  return undefined;
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
    | typeof CacheKey.OpenAppaHitlRuling,
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
