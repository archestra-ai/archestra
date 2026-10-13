import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { parseWorkloadPrincipal } from "@/services/agent-runtime/runtime-identity";
import { sessionCallerId } from "./actor";
import { isCommandExecutionTool } from "./command-normalization";
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
}): Promise<
  | { status: "staged" }
  | { status: "approve" | "deny" }
  | {
      status: "none";
      closure?: "declined" | "cancelled" | "unanswered" | "unavailable";
    }
> {
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

type HitlDecision = {
  ruling: HitlRuling;
  closure?: HitlClosureReason;
};

/** Observe a human ruling without spending the remedy's one-time approval. */
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
  // Claude Code can withhold long option previews entirely.
  // Keep the exact call and review coverage in the question on every host.
  const args = withoutCommandAlias(
    review.tool,
    parseReviewedArguments(review.arguments) ?? {},
  );
  const accepted = acceptedCoverage(review.text);
  return {
    question:
      approvalQuestion({ tool: review.tool, args, accepted }) ??
      formatReviewQuestion(review.text),
    header: "Approval",
    options,
    allowMultiple: false,
    remedy_offer_ids: [offerId],
  };
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
      const issued = await cache.get<{ offerId: string }>(
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

/**
 * The review as one question: the call by the name the user knows it under,
 * its arguments as named values, and what an approval accepts besides the
 * person's attention, such as a wider audience. Undefined when the review
 * text's coverage is not in the shape read here, so the full text is shown
 * and nothing it covers is left out.
 */
function approvalQuestion(params: {
  tool: string;
  args: Record<string, unknown>;
  accepted: string[] | undefined;
}): string | undefined {
  if (!params.accepted) return undefined;
  const argumentLines = formatArgumentLines(params.args);
  return [
    `Approve ${reviewedToolLabel(params.tool)}?`,
    // Native clients can truncate long questions; show review coverage first.
    ...acceptedBlock(params.accepted),
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
  closure?: unknown;
};

type LockedCache = Parameters<Parameters<typeof cacheManager.withLock>[1]>[0];

function closureOf(
  entry: StoredRuling | undefined,
): HitlClosureReason | undefined {
  return isHitlClosureReason(entry?.closure) ? entry.closure : undefined;
}

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
