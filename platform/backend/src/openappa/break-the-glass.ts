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
 * agent can run itself is left to them.
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
 * Notes that the proxy admitted a request of this session as unattended, for
 * the gateway: a remedy plan the agent runs there can need a person's review,
 * and the gateway sees the runtime credential and the client's headers only
 * through this note. The proxy refreshes it on every request, so a lost note
 * costs one review that waits for a person, as it did before.
 */
export async function rememberUnattendedSession(
  session: OpenAppaSession,
): Promise<void> {
  const key = unattendedSessionKey(session);
  // A session sends many requests; one note per process every few minutes
  // keeps the day-long note fresh.
  if (noted.get(key)) return;
  try {
    await cacheManager.set<true>(key, true, TimeInMs.Day);
    noted.set(key, true);
  } catch (error) {
    logger.warn(
      { err: error, sessionId: session.session_id },
      "OpenAPPA could not note the session as unattended",
    );
  }
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
  try {
    const recorded = await withDbTransaction(async (tx) => {
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
    rememberRecordedCalls({ ...scope, toolCallIds: fresh });
    if (!recorded) return true;
  } catch (err) {
    logger.warn(
      { err, sessionId: session.session_id, toolCallIds: [...byId.keys()] },
      "OpenAPPA could not record the calls it let through, so the batch is refused",
    );
    return false;
  }
  for (const call of params.calls) logWaiver({ session, ...call, superyell });
  return true;
}

/** `recordWaivedCalls` for one call. */
export async function recordWaivedCall(params: {
  session: OpenAppaSession;
  toolCallId: string;
  tool: string;
  kind: WaiverKind;
  superyell: boolean;
}): Promise<boolean> {
  const { session, superyell, ...call } = params;
  return recordWaivedCalls({ session, calls: [call], superyell });
}

/**
 * Records a review the platform waived at the gateway, when a remedy plan
 * needed a person's approval in an unattended session: the yell, and with
 * `superyell` the session bypass, as `recordWaivedCall` does. The runtime
 * authorizes the plan itself, so no call marker is needed; the record follows
 * that authorization. Returns false when the record fails, so the receipt can
 * say so.
 */
export async function recordWaivedReview(params: {
  session: OpenAppaSession;
  tool: string;
  superyell: boolean;
}): Promise<boolean> {
  // Reports off: nothing to record a yell in, so nothing turns the session off.
  const superyell = params.superyell && openappaYellEnabled();
  try {
    await withDbTransaction((tx) =>
      recordWaiver(
        { ...params, superyell, kind: "approval_waived", calls: 1 },
        tx,
      ),
    );
  } catch (err) {
    logger.warn(
      { err, sessionId: params.session.session_id, tool: params.tool },
      "OpenAPPA could not record a waived review",
    );
    return false;
  }
  logWaiver({ ...params, superyell, kind: "approval_waived", review: true });
  return true;
}

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

// The runtime renders the missing marks as `requires attention: <mark>, …`;
// newer OpenAPPA names the reserved mark `hard-block`. The deny decision
// carries no structured mark list, so the rendering is what there is to read.
const HARD_BLOCK = /requires attention: [^\n]*\b(?:blocked|hard-block)\b/;

const noted = registerProcessLocalCache(
  new LRUCacheManager<true>({
    maxSize: 10_000,
    defaultTtl: TimeInMs.Minute * 10,
  }),
);

const WAIVER_MESSAGE: Record<WaiverKind, string> = {
  approval_waived: "Break the glass waived human approval for",
  block_waived: "Soft block let a blocked call through:",
};
