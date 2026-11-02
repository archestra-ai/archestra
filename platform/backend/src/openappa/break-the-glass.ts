import type { IncomingHttpHeaders } from "node:http";
import { UNATTENDED_HEADER } from "@archestra/shared";
import logger from "@/logging";
import OpenAppaYellModel from "@/models/openappa-yell";
import type {
  HumanApprovalMode,
  UnapprovableBlockMode,
} from "@/types/guardrails-policy";
import type { OpenAppaYellKind } from "@/types/openappa-yell";
import { type OpenAppaSession, openappaYellEnabled } from "./service";
import { recordUnenforcedCalls, superyellSession } from "./unenforced";

export type WaiverKind = Exclude<OpenAppaYellKind, "agent">;

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
  settings: {
    active: boolean;
    humanApprovalMode: HumanApprovalMode;
    unapprovableBlockMode: UnapprovableBlockMode;
  };
  unattended: boolean;
}): WaiverKind | null {
  const { decision, settings } = params;
  if (!settings.active || decision.recorded !== true || decision.unanswered)
    return null;
  if (HARD_BLOCK.test(decision.feedback)) return null;
  if (decision.review?.length) {
    const waives =
      settings.humanApprovalMode === "everywhere" ||
      (settings.humanApprovalMode === "unattended" && params.unattended);
    return waives ? "approval_waived" : null;
  }
  if (decision.offers?.length === 0)
    return settings.unapprovableBlockMode === "allow" ? "block_waived" : null;
  return null;
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
 * Records a call let through under the Break the glass settings: as a call
 * the runtime does not see, so its result reaches the model as it is, and as
 * a platform yell unless reports are off. The yell names only the tool: the
 * session's trace holds the rest. A platform yell does what an agent's yell
 * does: with `superyell` (the Yell tool setting that turns Guardrails off) it
 * also takes the session out of OpenAPPA from its next request. Returns false
 * when a record fails; the call is then refused as ruled, since a released
 * call nothing recorded would have its result answered with the ruling.
 */
export async function recordWaivedCall(params: {
  session: OpenAppaSession;
  toolCallId: string;
  tool: string;
  kind: WaiverKind;
  superyell: boolean;
}): Promise<boolean> {
  const { session } = params;
  try {
    await recordUnenforcedCalls({
      organizationId: session.organization_id,
      sessionId: session.session_id,
      toolCallIds: [params.toolCallId],
      reason: "waived",
    });
    if (openappaYellEnabled()) {
      await OpenAppaYellModel.recordWaiver({
        organizationId: session.organization_id,
        callerId: session.caller_id ?? "unknown",
        sessionId: session.session_id,
        kind: params.kind,
        tool: params.tool,
        message: `${WAIVER_MESSAGE[params.kind]} ${params.tool}`,
        superyell: params.superyell,
      });
      if (params.superyell) await superyellSession(session);
    }
  } catch (err) {
    logger.warn(
      { err, sessionId: session.session_id, toolCallId: params.toolCallId },
      "OpenAPPA could not record a waived call, so it stays refused",
    );
    return false;
  }
  logger.warn(
    {
      organizationId: session.organization_id,
      sessionId: session.session_id,
      toolCallId: params.toolCallId,
      tool: params.tool,
      kind: params.kind,
      superyell: params.superyell,
    },
    params.superyell
      ? "OpenAPPA let a denied call through under the Break the glass settings and turned off for the session"
      : "OpenAPPA let a denied call through under the Break the glass settings",
  );
  return true;
}

// ===

// The runtime renders a missing mark as `requires attention: <mark>`; newer
// OpenAPPA names the reserved mark `hard-block`.
const HARD_BLOCK = /requires attention: (?:blocked|hard-block)\b/;

const WAIVER_MESSAGE: Record<WaiverKind, string> = {
  approval_waived: "Break the glass waived human approval for",
  block_waived: "Soft block let a blocked call through:",
};
