import { z } from "zod";
import OpenAppaNativeRoomModel from "@/models/openappa-native-room";
import {
  contentDigest,
  NATIVE_INGRESS_TOOL,
  NATIVE_PROVIDERS,
  NATIVE_REPLY_TOOL,
  type NativeRoomFacts,
  normalizeEmails,
} from "@/openappa/native-contract";
import {
  dispatchOpenappaEvent,
  nativeGuardrailsActive,
  type OpenAppaSession,
  startOpenappaSession,
} from "@/openappa/service";
import { startedUnenforced } from "@/openappa/unenforced";
import { ApiError } from "@/types";

type NativePart = { id: string; content: string };

type NativeIngressResult =
  | {
      decision: "admitted";
      parts: Array<{
        id: string;
        text: string;
        outputSource: "tool" | "runtime";
      }>;
    }
  | {
      decision: "refused";
      reason: "consult" | "withheld" | "conflict" | "legacy_policy";
    }
  | { decision: "not_governed"; reason: "disabled" | "unenforced" };

type NativeEgressResult =
  | {
      decision: "allowed";
      complete: (outcome: "success" | "failure") => Promise<void>;
    }
  | { decision: "already_delivered" }
  | {
      decision: "refused";
      reason: "audience" | "consult" | "denied" | "conflict" | "legacy_policy";
    }
  | { decision: "not_governed"; reason: "disabled" | "unenforced" };

/**
 * Admit every model-visible part before the turn. A replay returns the stored
 * approved bytes, never the caller's new body. A refusal includes no text.
 *
 * @public — ChatOps and Outlook ingress
 */
export async function admitNativeIngress(params: {
  session: OpenAppaSession;
  eventId: string;
  facts: NativeRoomFacts;
  parts: NativePart[];
}): Promise<NativeIngressResult> {
  const gate = await gateSession(params.session);
  if (gate) return gate;
  const prepared = prepare(params.session.organization_id, params.facts);
  if (!prepared.ok) return { decision: "refused", reason: "consult" };
  if (!validEventId(params.eventId) || params.parts.length === 0) {
    return { decision: "refused", reason: "consult" };
  }
  const ids = new Set(params.parts.map((part) => part.id));
  if (ids.size !== params.parts.length) {
    return { decision: "refused", reason: "consult" };
  }
  const registered = await OpenAppaNativeRoomModel.register({
    organizationId: params.session.organization_id,
    facts: prepared.facts,
  });
  if (registered.status === "conflict") {
    return { decision: "refused", reason: "conflict" };
  }
  try {
    await startOpenappaSession(params.session);
  } catch (error) {
    return mapFailure(error, "ingress");
  }
  const admitted: Array<{
    id: string;
    text: string;
    outputSource: "tool" | "runtime";
  }> = [];
  for (const part of params.parts) {
    const callId = partCallId(params.eventId, part.id);
    const digest = contentDigest(part.content);
    const outcome = await admitPart({
      session: params.session,
      callId,
      roomId: registered.snapshot.roomId,
      digest,
      content: part.content,
    });
    if (outcome.decision !== "admitted") return outcome;
    admitted.push({ id: part.id, ...outcome.part });
  }
  return { decision: "admitted", parts: admitted };
}

/**
 * Check the actual destination against the current label. Only `allowed` may
 * send, and `complete` must follow the provider API. A successful replay is
 * `already_delivered` and must not be sent again.
 *
 * @public — ChatOps and Outlook egress
 */
export async function authorizeNativeEgress(params: {
  session: OpenAppaSession;
  eventId: string;
  facts: NativeRoomFacts;
  content: string;
}): Promise<NativeEgressResult> {
  const gate = await gateSession(params.session);
  if (gate) return gate;
  const prepared = prepare(params.session.organization_id, params.facts);
  if (!prepared.ok || !validEventId(params.eventId)) {
    return { decision: "refused", reason: "consult" };
  }
  const registered = await OpenAppaNativeRoomModel.register({
    organizationId: params.session.organization_id,
    facts: prepared.facts,
  });
  if (registered.status === "conflict") {
    return { decision: "refused", reason: "conflict" };
  }
  const digest = contentDigest(params.content);
  const prior = await OpenAppaNativeRoomModel.findDelivery({
    organizationId: params.session.organization_id,
    sessionId: params.session.session_id,
    eventId: params.eventId,
  });
  if (prior) {
    if (
      prior.contentDigest !== digest ||
      prior.roomId !== registered.snapshot.roomId
    ) {
      return { decision: "refused", reason: "conflict" };
    }
    if (prior.status === "delivered") return { decision: "already_delivered" };
    return { decision: "refused", reason: "conflict" };
  }
  try {
    await startOpenappaSession(params.session);
    const decision = await dispatchOpenappaEvent(params.session, {
      event: "tool_call",
      operation_id: `call:${params.eventId}`,
      tool: NATIVE_REPLY_TOOL,
      native_boundary: true,
      arguments: callArguments(registered.snapshot.roomId, digest),
    });
    const refused = refuseEgress(decision);
    if (refused) return refused;
    if (decision.decision !== "allow_call") {
      return { decision: "refused", reason: "denied" };
    }
  } catch (error) {
    return mapFailure(error, "egress");
  }
  const roomId = registered.snapshot.roomId;
  const claimed = await OpenAppaNativeRoomModel.claimDelivery({
    organizationId: params.session.organization_id,
    sessionId: params.session.session_id,
    eventId: params.eventId,
    roomId,
    contentDigest: digest,
  });
  if (!claimed) {
    return { decision: "refused", reason: "conflict" };
  }
  let completionStarted = false;
  return {
    decision: "allowed",
    complete: async (outcome) => {
      if (completionStarted) {
        throw new ApiError(
          409,
          "Native delivery completion was already started",
        );
      }
      completionStarted = true;
      await completeEgress({
        session: params.session,
        eventId: params.eventId,
        roomId,
        digest,
        content: params.content,
        outcome,
      });
    },
  };
}

async function admitPart(params: {
  session: OpenAppaSession;
  callId: string;
  roomId: string;
  digest: string;
  content: string;
}): Promise<
  | {
      decision: "admitted";
      part: { text: string; outputSource: "tool" | "runtime" };
    }
  | Extract<NativeIngressResult, { decision: "refused" }>
> {
  try {
    const call = await dispatchOpenappaEvent(params.session, {
      event: "tool_call",
      operation_id: `call:${params.callId}`,
      tool: NATIVE_INGRESS_TOOL,
      native_boundary: true,
      arguments: callArguments(params.roomId, params.digest),
    });
    const refused = refuseIngress(call);
    if (refused) return refused;
    if (call.decision !== "allow_call") {
      return { decision: "refused", reason: "withheld" };
    }
    const result = await dispatchOpenappaEvent(params.session, {
      event: "tool_result",
      tool_call_id: params.callId,
      tool: NATIVE_INGRESS_TOOL,
      native_boundary: true,
      output: params.content,
      outcome: "success",
    });
    return acceptedPart(result, params.content);
  } catch (error) {
    return mapFailure(error, "ingress");
  }
}

function acceptedPart(
  decision: {
    decision: string;
    approved_output?: string;
    output_source?: string;
  },
  submitted: string,
):
  | {
      decision: "admitted";
      part: { text: string; outputSource: "tool" | "runtime" };
    }
  | Extract<NativeIngressResult, { decision: "refused" }> {
  if (
    decision.decision === "block" ||
    decision.decision === "refuse" ||
    decision.decision === "deny_call"
  ) {
    const replacement = decision.approved_output;
    if (
      decision.output_source === "runtime" &&
      typeof replacement === "string" &&
      replacement !== submitted
    ) {
      return {
        decision: "admitted",
        part: { text: replacement, outputSource: "runtime" },
      };
    }
    return { decision: "refused", reason: "withheld" };
  }
  if (decision.decision !== "ack" && decision.decision !== "allow_call") {
    return { decision: "refused", reason: "withheld" };
  }
  const text = decision.approved_output ?? submitted;
  if (decision.output_source === "runtime" || text !== submitted) {
    if (text === submitted) return { decision: "refused", reason: "withheld" };
    return {
      decision: "admitted",
      part: { text, outputSource: "runtime" },
    };
  }
  return { decision: "admitted", part: { text, outputSource: "tool" } };
}

async function completeEgress(params: {
  session: OpenAppaSession;
  eventId: string;
  roomId: string;
  digest: string;
  content: string;
  outcome: "success" | "failure";
}): Promise<void> {
  // Persist the provider outcome first. If the runtime receipt fails, retrying
  // must not send again or turn a successful send into a failed receipt.
  await OpenAppaNativeRoomModel.recordDelivery({
    organizationId: params.session.organization_id,
    sessionId: params.session.session_id,
    eventId: params.eventId,
    roomId: params.roomId,
    contentDigest: params.digest,
    status: params.outcome === "success" ? "delivered" : "failed",
  });
  const decision = await dispatchOpenappaEvent(params.session, {
    event: "tool_result",
    tool_call_id: params.eventId,
    tool: NATIVE_REPLY_TOOL,
    native_boundary: true,
    output: params.content,
    outcome: params.outcome,
  });
  if (params.outcome === "failure") {
    return;
  }
  if (decision.decision !== "ack" && decision.decision !== "allow_call") {
    throw new ApiError(409, "OpenAPPA did not accept the native reply result");
  }
}

async function gateSession(session: OpenAppaSession): Promise<{
  decision: "not_governed";
  reason: "disabled" | "unenforced";
} | null> {
  if (!(await nativeGuardrailsActive())) {
    return { decision: "not_governed", reason: "disabled" };
  }
  if (await startedUnenforced(session)) {
    return { decision: "not_governed", reason: "unenforced" };
  }
  return null;
}

function prepare(
  organizationId: string,
  facts: NativeRoomFacts,
): { ok: true; facts: NativeRoomFacts } | { ok: false } {
  if (
    !organizationId ||
    !(NATIVE_PROVIDERS as readonly string[]).includes(facts.ref.provider)
  ) {
    return { ok: false };
  }
  if (!facts.ref.workspaceId || !facts.ref.channelId) return { ok: false };
  if (facts.trust !== "trusted" && facts.trust !== "suspicious") {
    return { ok: false };
  }
  if (facts.readers.status === "unresolved") {
    return {
      ok: true,
      facts: { ...facts, readers: { status: "unresolved" } },
    };
  }
  if (
    facts.readers.status !== "resolved" ||
    !Array.isArray(facts.readers.emails) ||
    facts.readers.emails.length === 0 ||
    facts.readers.emails.some(
      (email) =>
        typeof email !== "string" ||
        !z.email().safeParse(email.trim().toLowerCase()).success,
    )
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    facts: {
      ...facts,
      readers: {
        status: "resolved",
        emails: normalizeEmails(facts.readers.emails),
      },
    },
  };
}

function callArguments(roomId: string, digest: string): string {
  return JSON.stringify({ room_id: roomId, content_digest: digest });
}

function partCallId(eventId: string, partId: string): string {
  return partId.length === 0 ? eventId : `${eventId}:${partId}`;
}

function validEventId(eventId: string): boolean {
  return eventId.length > 0 && !eventId.includes("\n") && eventId.length <= 512;
}

function refuseIngress(decision: {
  decision: string;
  detail?: string;
}): Extract<NativeIngressResult, { decision: "refused" }> | null {
  if (decision.decision === "refuse" && decision.detail === "legacy_policy") {
    return { decision: "refused", reason: "legacy_policy" };
  }
  if (decision.decision === "refuse") {
    return { decision: "refused", reason: "consult" };
  }
  if (decision.decision === "deny_call" || decision.decision === "block") {
    return { decision: "refused", reason: "withheld" };
  }
  return null;
}

function refuseEgress(decision: {
  decision: string;
  detail?: string;
  feedback?: string;
}): Extract<NativeEgressResult, { decision: "refused" }> | null {
  if (decision.decision === "refuse" && decision.detail === "legacy_policy") {
    return { decision: "refused", reason: "legacy_policy" };
  }
  if (decision.decision === "refuse") {
    return { decision: "refused", reason: "consult" };
  }
  if (decision.decision === "deny_call") {
    const feedback = decision.feedback ?? "";
    if (feedback.toLowerCase().includes("audience")) {
      return { decision: "refused", reason: "audience" };
    }
    return { decision: "refused", reason: "denied" };
  }
  if (decision.decision === "block") {
    return { decision: "refused", reason: "denied" };
  }
  return null;
}

function mapFailure(
  error: unknown,
  side: "ingress",
): Extract<NativeIngressResult, { decision: "refused" }>;
function mapFailure(
  error: unknown,
  side: "egress",
): Extract<NativeEgressResult, { decision: "refused" }>;
function mapFailure(
  error: unknown,
  side: "ingress" | "egress",
):
  | Extract<NativeIngressResult, { decision: "refused" }>
  | Extract<NativeEgressResult, { decision: "refused" }> {
  const text = errorText(error);
  if (
    text.includes("different input") ||
    text.includes("different value") ||
    text.includes("another authenticated scope")
  ) {
    return { decision: "refused", reason: "conflict" };
  }
  if (text.includes("legacy_policy")) {
    return { decision: "refused", reason: "legacy_policy" };
  }
  if (side === "ingress") return { decision: "refused", reason: "consult" };
  return { decision: "refused", reason: "consult" };
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return `${error.message} ${cause}`;
}
