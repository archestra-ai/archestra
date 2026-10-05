import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import type { OpenAppaSession } from "./service";

type HitlRuling = "approve" | "deny" | "none";

type HitlRestriction = {
  dimension: string;
  before: string;
  after: string;
};

type PendingHitlReview = {
  offerId: string;
  text: string;
  tool?: string;
  arguments?: string;
  remedyArguments?: Record<string, unknown>;
  restrictions?: HitlRestriction[];
};

const RESTRICTION_HEADING =
  "Persistent session restriction this approval would accept:";

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
  await cacheManager.set(
    reviewKey(params.session, params.review.offerId),
    params.review,
    HITL_REVIEW_TTL_MS,
  );
}

/**
 * Stages a review loaded from a verified offer when none is staged yet.
 * Does not overwrite an existing review, and does not stage a review whose
 * restriction list cannot be shown in full.
 */
export async function stageLoadedHitlReview(params: {
  session: OpenAppaSession;
  review: {
    offer_id: string;
    text: string;
    tool?: string;
    arguments?: string;
    restrictions?: HitlRestriction[];
    remedyArguments?: Record<string, unknown>;
  };
}): Promise<"staged" | "existing" | "unusable"> {
  const existing = await getHitlReview({
    session: params.session,
    offerId: params.review.offer_id,
  });
  if (existing) return "existing";
  const restrictions = verifiedRestrictions(params.review.restrictions);
  const remedyArguments = plainRemedyArguments(params.review.remedyArguments);
  if (
    !restrictions ||
    remedyArguments === "invalid" ||
    (params.review.text.length === 0 && restrictions.length === 0)
  ) {
    return "unusable";
  }
  await stageHitlReview({
    session: params.session,
    review: {
      offerId: params.review.offer_id,
      text: params.review.text,
      ...(params.review.tool ? { tool: params.review.tool } : {}),
      ...(params.review.arguments
        ? { arguments: params.review.arguments }
        : {}),
      ...(restrictions.length > 0 ? { restrictions } : {}),
      ...(remedyArguments ? { remedyArguments } : {}),
    },
  });
  return "staged";
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

export async function getHitlAskUserArguments(params: {
  session: OpenAppaSession;
  offerIds: readonly string[];
}): Promise<HitlAskUserArguments | undefined> {
  if (params.offerIds.length !== 1) return undefined;
  const offerId = params.offerIds[0];
  const review = await getHitlReview({ session: params.session, offerId });
  if (!review) return undefined;
  const restrictions = verifiedRestrictions(review.restrictions);
  if (!restrictions) return undefined;
  return {
    question: questionText(review.text, restrictions),
    header: "Approval",
    options: approvalOptions(restrictions),
    allowMultiple: false,
    remedy_offer_ids: [offerId],
  };
}

export function formatHitlReviewMessage(text: string): string {
  return text.replace(
    /^▄█▄▄▄█▄ {2}▀▀█ {2}([^\n]*)\n██▄█▄██ {3}▄ {3}/,
    "▄█▄▄▄█▄  $1\n██▄█▄██  ",
  );
}

function verifiedRestrictions(
  restrictions: HitlRestriction[] | undefined,
): HitlRestriction[] | undefined {
  if (!restrictions || restrictions.length === 0) return [];
  const verified = restrictions.filter(
    (restriction) =>
      (restriction.dimension === "trust" ||
        restriction.dimension === "readers") &&
      isLabel(restriction.before) &&
      isLabel(restriction.after),
  );
  return verified.length === restrictions.length ? verified : undefined;
}

function isLabel(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.split("").some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function questionText(text: string, restrictions: HitlRestriction[]): string {
  text = formatHitlReviewMessage(text);
  if (restrictions.length === 0) return text;
  const lines = restrictions
    .map(
      (restriction) =>
        `  ${restriction.dimension}: ${restriction.before} -> ${restriction.after}`,
    )
    .join("\n");
  const section = `${RESTRICTION_HEADING}\n${lines}\nApproving authorizes this exact call and accepts each listed restriction for the rest of this session. These label changes only tighten session restrictions; they do not add permissions. Denying keeps the call blocked and does not accept the restriction.`;
  if (text.endsWith(section)) return text;
  return text.length === 0 ? section : `${text}\n\n${section}`;
}

function approvalOptions(restrictions: HitlRestriction[]) {
  if (restrictions.length === 0) {
    return [
      {
        label: "Approve",
        description: "Allow this exact tool call.",
      },
      {
        label: "Deny",
        description: "Keep this tool call blocked.",
      },
    ];
  }
  const listed = restrictions
    .map(
      (restriction) =>
        `${restriction.dimension} ${restriction.before} -> ${restriction.after}`,
    )
    .join("; ");
  return [
    {
      label: "Approve",
      description: `Authorize this exact call and accept these session restrictions: ${listed}. The label changes do not add permissions.`,
    },
    {
      label: "Deny",
      description:
        "Keep this call blocked and do not accept the listed restrictions.",
    },
  ];
}

export async function recordHitlRuling(params: {
  session: OpenAppaSession;
  offerId: string;
  ruling: HitlRuling;
}): Promise<boolean> {
  const pending = await getHitlReview(params);
  if (!pending) return false;
  await cacheManager.set(
    rulingKey(params.session, params.offerId, params.ruling),
    { offerId: params.offerId, ruling: params.ruling },
    HITL_REVIEW_TTL_MS,
  );
  if (params.ruling !== "approve") {
    await cacheManager.delete(reviewKey(params.session, params.offerId));
  }
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
  return selected;
}

export async function clearHitlReview(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<void> {
  await Promise.all([
    cacheManager.delete(reviewKey(params.session, params.offerId)),
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

function plainRemedyArguments(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "invalid";
  }
  return { ...value };
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
