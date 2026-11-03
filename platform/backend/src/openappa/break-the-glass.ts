import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { TimeInMs, UNATTENDED_HEADER } from "@archestra/shared";
import {
  type AllowedCacheKey,
  CacheKey,
  cacheManager,
  LRUCacheManager,
} from "@/cache-manager";
import { type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import OpenAppaYellModel from "@/models/openappa-yell";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import type {
  HumanApprovalMode,
  UnapprovableBlockMode,
} from "@/types/guardrails-policy";
import type { OpenAppaYellKind } from "@/types/openappa-yell";
import { type OpenAppaSession, openappaYellEnabled } from "./service";
import {
  rememberRecordedCalls,
  superyellSession,
  unrecordedCallIds,
} from "./unenforced";

export type WaiverKind = Exclude<OpenAppaYellKind, "agent">;

/** How a review the platform answered went; see `recordWaivedReview`. */
export type WaivedReviewRecord =
  | "recorded"
  | "reports_off"
  | "refused"
  | "failed";

type BreakTheGlassSettings = {
  active: boolean;
  humanApprovalMode: HumanApprovalMode;
  unapprovableBlockMode: UnapprovableBlockMode;
};

/**
 * Whether the Break the glass settings let a denied call through, and as
 * which kind of yell. Only a denial the runtime recorded qualifies: a call
 * waiting for human approval (it offers a review) under `humanApprovalMode`,
 * or a call no remedy can lift under `unapprovableBlockMode`. A call that
 * needs the `blocked` mark is never let through, and a call with remedies the
 * agent can run itself, an offer of its own or another tool to run first, is
 * left to them.
 */
export function waiverFor(params: {
  decision: {
    feedback: string;
    recorded?: boolean;
    unanswered?: boolean;
    offers?: readonly unknown[];
    review?: readonly unknown[];
  };
  settings: BreakTheGlassSettings;
  unattended: boolean;
}): WaiverKind | null {
  const { decision, settings } = params;
  if (!settings.active || decision.recorded !== true || decision.unanswered)
    return null;
  if (HARD_BLOCK.test(decision.feedback)) return null;
  // Another tool to run first is a remedy with no offer id; the agent runs it.
  if (REDISPATCH.test(decision.feedback)) return null;
  if (decision.review?.length) {
    // A remedy the agent can run itself is left to the agent: the setting
    // stands in for a person, not for the agent's own plans.
    const reviewed = new Set(decision.review.map(offerId));
    if ((decision.offers ?? []).some((offer) => !reviewed.has(offerId(offer))))
      return null;
    return humanApprovalWaived(settings, params.unattended)
      ? "approval_waived"
      : null;
  }
  if (decision.offers?.length === 0)
    return settings.unapprovableBlockMode === "allow" ? "block_waived" : null;
  return null;
}

/** An offer as the runtime lists it (its id) or as a review names it. */
function offerId(offer: unknown): string | undefined {
  if (typeof offer === "string") return offer;
  if (offer && typeof offer === "object" && "offer_id" in offer) {
    const id = (offer as { offer_id?: unknown }).offer_id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

/**
 * Whether the Human approval setting reaches a session: everywhere, or only
 * where no person is there to answer.
 */
export function humanApprovalWaived(
  settings: BreakTheGlassSettings,
  unattended: boolean,
): boolean {
  return (
    settings.active &&
    (settings.humanApprovalMode === "everywhere" ||
      (settings.humanApprovalMode === "unattended" && unattended))
  );
}

/**
 * Whether no person is there to answer the request's approvals: an Agent
 * Runtime run, known from its authenticated runtime credential whatever image
 * it runs, or a client that sends `X-Archestra-Unattended: 1`.
 */
export function isUnattendedRequest(params: {
  headers: IncomingHttpHeaders;
  agentRuntimeRun: boolean;
}): boolean {
  return (
    params.agentRuntimeRun ||
    params.headers[UNATTENDED_HEADER.toLowerCase()] === "1"
  );
}

/**
 * Notes for the gateway whether the proxy admitted this session's latest
 * request as unattended: a remedy plan the agent runs there can need a
 * person's review, and the gateway sees the runtime credential and the
 * client's headers only through this note. The proxy writes or withdraws it
 * when it handles a denied batch with Human approval waived in unattended
 * sessions, the only mode in which the gateway reads it, so the note is
 * current when a review follows that batch. A lost note costs one review
 * that waits for a person, as it did before.
 */
export async function rememberUnattendedSession(
  session: OpenAppaSession,
  unattended: boolean,
): Promise<void> {
  const key = unattendedSessionKey(session);
  // A session sends many requests; one write per process every few minutes
  // keeps the day-long note fresh. An attended request always withdraws the
  // note: another replica may have written it since this process last did,
  // and a stale note would let the platform answer reviews with a person present.
  if (unattended && noted.get(key) === true) return;
  try {
    if (unattended) await cacheManager.set<true>(key, true, TimeInMs.Day);
    else await cacheManager.delete(key);
    noted.set(key, unattended);
  } catch (error) {
    logger.warn(
      { err: error, sessionId: session.session_id },
      "OpenAPPA could not note the session as unattended",
    );
  }
}

/** Whether the gateway reads the unattended note under these settings. */
export function unattendedNoteMatters(settings: {
  active: boolean;
  humanApprovalMode: "block" | "unattended" | "everywhere";
}): boolean {
  return settings.active && settings.humanApprovalMode === "unattended";
}

/** Whether the proxy admitted this session's requests as unattended. */
export async function isUnattendedSession(
  session: OpenAppaSession,
): Promise<boolean> {
  try {
    return (
      (await cacheManager.get<true>(unattendedSessionKey(session))) === true
    );
  } catch (error) {
    logger.warn(
      { err: error, sessionId: session.session_id },
      "OpenAPPA could not read whether the session is unattended",
    );
    return false;
  }
}

/** A call Break the glass lets through, as the proxy records it. */
export type WaivedCall = { toolCallId: string; tool: string; kind: WaiverKind };

/**
 * Records the calls of one batch that Break the glass let through: each as a
 * call the runtime does not see, so its result reaches the model as it is,
 * and as platform yells, one per tool and kind, unless reports are off. A
 * yell names only the tool: the session's trace holds the rest. A platform
 * yell does what an agent's yell does: with `superyell` (the Yell tool
 * setting that turns Guardrails off) it also takes the session out of
 * OpenAPPA from its next request. Without a yell there is no bypass either.
 *
 * The batch's markers, yells and session bypass commit together, so a failed
 * write leaves no marker behind that would pass a refused call's result on,
 * and no yell for a batch the client never got. A call recorded before counts
 * once: a repeated evaluation of the same call adds nothing to its yell.
 * Returns false when the record fails; the caller then keeps the batch from
 * the client, since a released call nothing recorded would have its result
 * answered with the ruling.
 */
export async function recordWaivedCalls(params: {
  session: OpenAppaSession;
  calls: readonly WaivedCall[];
  superyell: boolean;
}): Promise<boolean> {
  const { session } = params;
  if (params.calls.length === 0) return true;
  const scope = {
    organizationId: session.organization_id,
    sessionId: session.session_id,
  };
  const byId = new Map(params.calls.map((call) => [call.toolCallId, call]));
  const fresh = unrecordedCallIds({ ...scope, toolCallIds: [...byId.keys()] });
  // Reports off: nothing to record a yell in, so nothing turns the session off.
  const superyell = params.superyell && openappaYellEnabled();
  let recorded: boolean;
  try {
    recorded = await withDbTransaction(async (tx) => {
      const inserted = await OpenAppaUnenforcedModel.recordCalls(
        { ...scope, toolCallIds: fresh, reason: "waived" },
        tx,
      );
      if (inserted.length === 0) return false;
      // One yell per tool and kind, counting the calls recorded now.
      const groups = new Map<
        string,
        { tool: string; kind: WaiverKind; calls: number }
      >();
      for (const id of inserted) {
        const call = byId.get(id);
        if (!call) continue;
        const key = `${call.kind}\u0000${call.tool}`;
        const group = groups.get(key) ?? {
          tool: call.tool,
          kind: call.kind,
          calls: 0,
        };
        group.calls += 1;
        groups.set(key, group);
      }
      for (const group of groups.values())
        await recordWaiver({ session, ...group, superyell }, tx);
      return true;
    });
  } catch (err) {
    logger.warn(
      { err, sessionId: session.session_id, toolCallIds: [...byId.keys()] },
      "OpenAPPA could not record the calls it let through, so the batch is refused",
    );
    return false;
  }
  // Only a committed record is remembered; a thrown transaction leaves the
  // ids for the resent batch to record.
  rememberRecordedCalls({ ...scope, toolCallIds: fresh });
  if (!recorded) return true;
  for (const call of params.calls) logWaiver({ session, ...call, superyell });
  return true;
}

/**
 * Records a review the platform answers at the gateway in place of a person,
 * when a remedy plan needs one in an unattended session: the yell, and with
 * `superyell` the session bypass, as `recordWaivedCalls` does. The record is
 * written first and the plan authorized through `authorize` inside the same
 * transaction, so an authorized plan always has its record (as a waived
 * batch reaches the client only once recorded) and a plan the runtime
 * refuses or retires leaves none. No call marker is needed: the runtime rules
 * on the retried call itself. `failed` before `authorize` ran means nothing
 * was spent and the review is still open; after it ran (a commit lost for
 * good) the plan is authorized and the receipt says the yell is missing.
 */
export async function recordWaivedReview(params: {
  session: OpenAppaSession;
  tool: string;
  superyell: boolean;
  /** Authorizes the plan; false when the runtime refuses or retires it. */
  authorize: () => Promise<boolean>;
}): Promise<WaivedReviewRecord> {
  const { authorize, ...waiver } = params;
  const yell = { ...waiver, kind: "approval_waived" as const, review: true };
  // Reports off: nothing to record a yell in, so nothing turns the session off.
  if (!openappaYellEnabled()) {
    if (!(await authorize())) return "refused";
    logWaiver({ ...yell, superyell: false });
    return "reports_off";
  }
  let authorizing = false;
  try {
    await withDbTransaction(async (tx) => {
      await recordWaiver({ ...waiver, kind: "approval_waived", calls: 1 }, tx);
      authorizing = true;
      const through = await authorize();
      authorizing = false;
      // A refused plan rolls its record back.
      if (!through) throw REFUSED_PLAN;
    });
  } catch (err) {
    if (err === REFUSED_PLAN) return "refused";
    // The runtime's own failure is the caller's to answer, as before.
    if (authorizing) throw err;
    logger.warn(
      { err, sessionId: waiver.session.session_id, tool: waiver.tool },
      "OpenAPPA could not record a waived review",
    );
    return "failed";
  }
  logWaiver(yell);
  return "recorded";
}

const REFUSED_PLAN = Symbol("the runtime refused the plan");

/**
 * What the agent reads after a review the platform approved in place of a
 * person. The gateway appends one of these to the remedy result as its own
 * text block, and the proxy carries exactly these texts (nothing else) across
 * 1.4's runtime rendering.
 */
export const WAIVED_REVIEW_RECEIPTS: Record<
  Exclude<WaivedReviewRecord, "refused">,
  string
> = {
  recorded:
    "[appa] Break the glass receipt: this plan needed a person's approval, and Human approval is waived for this session, so the platform approved the review itself and recorded a yell in Guardrails → Yells. No human ruled. Follow the runtime outcome above. If a retry is authorized and still requested, copy its exact arguments without reconstructing or changing them.",
  reports_off:
    "[appa] Break the glass receipt: this plan needed a person's approval, and Human approval is waived for this session, so the platform approved the review itself. No human ruled. Yell reports are off in this deployment, so no yell was recorded. Follow the runtime outcome above. If a retry is authorized and still requested, copy its exact arguments without reconstructing or changing them.",
  failed:
    "[appa] Break the glass receipt: this plan needed a person's approval, and Human approval is waived for this session, so the platform approved the review itself. No human ruled. Guardrails could not record the yell for it: tell the user. Follow the runtime outcome above.",
};

// ===

async function recordWaiver(
  params: {
    session: OpenAppaSession;
    kind: WaiverKind;
    tool: string;
    superyell: boolean;
    calls: number;
  },
  tx: Transaction,
): Promise<void> {
  if (!openappaYellEnabled()) return;
  const { session } = params;
  await OpenAppaYellModel.recordWaiver(
    {
      organizationId: session.organization_id,
      callerId: session.caller_id ?? "unknown",
      sessionId: session.session_id,
      kind: params.kind,
      tool: params.tool,
      message: `${WAIVER_MESSAGE[params.kind]} ${params.tool}`,
      superyell: params.superyell,
      calls: params.calls,
    },
    tx,
  );
  if (params.superyell) await superyellSession(session, tx);
}

function logWaiver(params: {
  session: OpenAppaSession;
  tool: string;
  kind: WaiverKind;
  superyell: boolean;
  toolCallId?: string;
  review?: boolean;
}): void {
  const what = params.review
    ? "OpenAPPA waived a human review under the Break the glass settings"
    : "OpenAPPA let a denied call through under the Break the glass settings";
  logger.warn(
    {
      organizationId: params.session.organization_id,
      sessionId: params.session.session_id,
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      tool: params.tool,
      kind: params.kind,
      superyell: params.superyell,
    },
    params.superyell ? `${what} and turned off for the session` : what,
  );
}

function unattendedSessionKey(session: OpenAppaSession): AllowedCacheKey {
  const digest = createHash("sha256")
    .update(JSON.stringify([session.organization_id, session.session_id]))
    .digest("base64url");
  return `${CacheKey.OpenAppaUnattendedSession}-${digest}`;
}

// The deny decision carries no structured gap list, so the runtime's rendering
// is what there is to read. It renders the missing marks as `requires
// attention: <mark>, …`; the reserved mark is `blocked`, which an upstream
// OpenAPPA prototype renames `hard-block` (653c7e3b0), and a miss here would
// let a hard block through. A tool to run first (a redispatch, which mints no offer) renders as
// `- Run <tool> first; it clears: <gaps>.` under `Continue:`.
const HARD_BLOCK = /requires attention: [^\n]*\b(?:blocked|hard-block)\b/;
const REDISPATCH = /^\s*- Run .+ first; it clears: /m;

const noted = registerProcessLocalCache(
  new LRUCacheManager<boolean>({
    maxSize: 10_000,
    defaultTtl: TimeInMs.Minute * 10,
  }),
);

const WAIVER_MESSAGE: Record<WaiverKind, string> = {
  approval_waived: "Break the glass waived human approval for",
  block_waived: "Break the glass let a blocked call through:",
};
