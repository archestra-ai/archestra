import type { A2AAttachment } from "@/agents/a2a-executor";
import logger from "@/logging";
import type { OpenAppaSession } from "@/openappa/service";
import {
  observeUnenforcedSession,
  startedUnenforced,
} from "@/openappa/unenforced";
import { readGuardrailsV2Activation } from "@/services/guardrails-deployment";
import type { ChatOpsGuardrailsContext } from "@/types";
import { ApiError } from "@/types";
import {
  type AdmittedPart,
  applyAdmittedParts,
  contentDigest,
  type NativeProvider,
  type NativeRoomFacts,
} from "./native-contract";
import { admitNativeIngress, authorizeNativeEgress } from "./native-message";

/** Fixed notice. Never includes the refused text, file bytes, or exception. */
export const NATIVE_TRANSPORT_BLOCKED_NOTICE = "I can't process that here.";

export type TransportSession = {
  organizationId: string;
  sessionId: string;
  /** Omit for the system actor. A user is `user:<id>`. */
  callerId?: string;
  parentId?: string;
};

type TransportGovernance = "inactive" | "unenforced" | "governed";

function toOpenAppaSession(session: TransportSession): OpenAppaSession {
  return {
    organization_id: session.organizationId,
    session_id: session.sessionId,
    ...(session.callerId ? { caller_id: session.callerId } : {}),
    ...(session.parentId ? { parent_id: session.parentId } : {}),
  };
}

/**
 * Inactive arrivals are recorded before raw bytes are passed through, so a
 * later switch-on still sees an off-started session. An already off-started
 * session is not admitted into a new empty root.
 */
export async function transportGovernance(
  session: TransportSession,
): Promise<TransportGovernance> {
  const openAppa = toOpenAppaSession(session);
  if ((await readGuardrailsV2Activation()) !== "active") {
    // The arrival is the start boundary. Record it before any raw bytes reach
    // the model, so a switch that flips on before the proxy request still sees
    // an off-started session instead of an empty governed root.
    await observeUnenforcedSession(openAppa);
    return "inactive";
  }
  if (await startedUnenforced(openAppa)) return "unenforced";
  return "governed";
}

export function chatOpsRoomFacts(params: {
  provider: "slack" | "ms-teams" | "telegram";
  context: ChatOpsGuardrailsContext;
  threadId: string;
}): NativeRoomFacts | null {
  if (!params.threadId) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.context.roomId);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 3) return null;
  const [provider, workspaceId, channelId] = parsed;
  if (provider !== params.provider) return null;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;
  if (typeof channelId !== "string" || channelId.length === 0) return null;
  return {
    ref: {
      provider: params.provider,
      workspaceId,
      channelId,
      threadId: params.threadId,
    },
    trust: params.context.trust,
    readers:
      params.context.readers === null
        ? { status: "unresolved" }
        : { status: "resolved", emails: [...params.context.readers] },
  };
}

function emailRoomFacts(params: {
  mailbox: string;
  threadId: string;
  recipients: string[] | null;
}): NativeRoomFacts | null {
  const mailbox = params.mailbox.trim().toLowerCase();
  if (!mailbox || !params.threadId) return null;
  return {
    ref: {
      provider: "outlook",
      workspaceId: mailbox,
      channelId: params.threadId,
      threadId: params.threadId,
    },
    trust: "suspicious",
    readers:
      params.recipients === null
        ? { status: "unresolved" }
        : { status: "resolved", emails: [...params.recipients] },
  };
}

export function renderOutboundContent(params: {
  text: string;
  hint?: string;
  footer?: string;
}): string {
  return [params.text, params.hint, params.footer]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
}

function inboundParts(params: {
  body: string;
  history: readonly string[];
  attachments: readonly A2AAttachment[];
}): Array<{ id: string; content: string }> {
  return [
    { id: "", content: params.body },
    ...params.history.map((line, index) => ({
      id: `history:${index}`,
      content: line,
    })),
    ...params.attachments.map((attachment, index) => ({
      id: `attachment:${index}`,
      content: attachment.contentBase64,
    })),
  ];
}

type ChatOpsAdmission =
  | { decision: "pass" }
  | { decision: "refused" }
  | {
      decision: "admitted";
      body: string;
      history: string[];
      attachments: A2AAttachment[];
    };

export async function admitChatOpsTurn(params: {
  session: TransportSession;
  providerId: string;
  eventId: string;
  threadId: string;
  body: string;
  bodyContainsHistory?: boolean;
  history: readonly string[];
  attachments: readonly A2AAttachment[];
  resolveFacts: () => Promise<ChatOpsGuardrailsContext | null>;
}): Promise<ChatOpsAdmission> {
  const governance = await transportGovernance(params.session);
  if (governance !== "governed") return { decision: "pass" };
  if (!supportedNativeProvider(params.providerId)) {
    return { decision: "refused" };
  }
  let context: ChatOpsGuardrailsContext | null;
  try {
    context = await params.resolveFacts();
  } catch (error) {
    logger.warn(
      { error, provider: params.providerId },
      "[NativeTransport] Room fact lookup failed; refusing the turn",
    );
    return { decision: "refused" };
  }
  const facts = context
    ? chatOpsRoomFacts({
        provider: params.providerId,
        context,
        threadId: params.threadId,
      })
    : null;
  if (!facts) return { decision: "refused" };
  const admitted = await admitParts({
    session: params.session,
    eventId: `ingress:${params.eventId}`,
    facts: params.bodyContainsHistory
      ? { ...facts, trust: "suspicious" }
      : facts,
    parts: inboundParts(params),
  });
  if (admitted.decision === "pass") return { decision: "pass" };
  if (admitted.decision === "refused") return { decision: "refused" };
  const applied = applyAdmittedParts({
    admitted: admitted.parts,
    body: params.body,
    history: params.history,
    attachments: params.attachments,
  });
  if (!applied.ok) return { decision: "refused" };
  return { decision: "admitted", ...applied };
}

type OutboundAuthorization =
  | { decision: "pass" }
  | { decision: "already_delivered"; eventId: string }
  | { decision: "refused" }
  | {
      decision: "allowed";
      eventId: string;
      complete: (outcome: "success" | "failure") => Promise<void>;
    };

export async function authorizeOutbound(params: {
  session: TransportSession;
  eventId: string;
  facts: NativeRoomFacts;
  content: string;
  strictDelivery?: boolean;
}): Promise<OutboundAuthorization> {
  const governance = await transportGovernance(params.session);
  if (governance !== "governed") return { decision: "pass" };
  try {
    const decision = await authorizeNativeEgress({
      session: toOpenAppaSession(params.session),
      eventId: params.eventId,
      facts: params.facts,
      content: params.content,
    });
    if (decision.decision === "not_governed") return { decision: "pass" };
    if (decision.decision === "already_delivered") {
      return { decision: "already_delivered", eventId: params.eventId };
    }
    if (decision.decision === "refused") {
      if (params.strictDelivery)
        throw new ApiError(
          decision.reason === "consult"
            ? 503
            : decision.reason === "conflict"
              ? 409
              : 403,
          "Native review delivery was refused",
          decision.reason === "consult"
            ? "native_delivery_lookup"
            : decision.reason === "conflict"
              ? "native_delivery_ambiguous"
              : "native_delivery_denied",
        );
      return { decision: "refused" };
    }
    return {
      decision: "allowed",
      eventId: params.eventId,
      complete: decision.complete,
    };
  } catch (error) {
    if (params.strictDelivery) {
      if (
        error instanceof ApiError &&
        error.internalCode?.startsWith("native_delivery_")
      )
        throw error;
      throw new ApiError(
        503,
        "Native review delivery authorization is unavailable",
        "native_delivery_lookup",
      );
    }
    logger.warn(
      { error, eventId: params.eventId },
      "[NativeTransport] Egress authorization failed closed",
    );
    return { decision: "refused" };
  }
}

/**
 * Send only after authorization. `already_delivered` and `refused` do not
 * call `send`. `complete` runs only for an allowed send.
 */
export async function completeAuthorizedSend(
  decision: OutboundAuthorization,
  send: () => Promise<unknown>,
): Promise<"sent" | "already_delivered" | "refused" | "passed"> {
  if (decision.decision === "already_delivered") return "already_delivered";
  if (decision.decision === "refused") return "refused";
  try {
    await send();
  } catch (error) {
    if (decision.decision === "allowed") await decision.complete("failure");
    throw error;
  }
  if (decision.decision === "allowed") await decision.complete("success");
  return decision.decision === "allowed" ? "sent" : "passed";
}

export function egressEventId(scope: string, content: string): string {
  return `${scope}:${contentDigest(content)}`;
}

export async function authorizeChatOpsReply(params: {
  session: TransportSession;
  providerId: string;
  messageId: string;
  threadId: string;
  content: string;
  resolveFacts: () => Promise<ChatOpsGuardrailsContext | null>;
  strictDelivery?: boolean;
}): Promise<OutboundAuthorization> {
  const governance = await transportGovernance(params.session);
  if (governance !== "governed") return { decision: "pass" };
  if (!supportedNativeProvider(params.providerId)) {
    if (params.strictDelivery)
      throw new ApiError(
        403,
        "Unsupported native review destination",
        "native_delivery_denied",
      );
    return { decision: "refused" };
  }
  let context: ChatOpsGuardrailsContext | null;
  try {
    context = await params.resolveFacts();
  } catch (error) {
    if (params.strictDelivery)
      throw new ApiError(
        error instanceof ApiError && [401, 403].includes(error.statusCode)
          ? 403
          : 503,
        "Native review room lookup is unavailable",
        error instanceof ApiError && [401, 403].includes(error.statusCode)
          ? "native_delivery_denied"
          : "native_delivery_lookup",
      );
    logger.warn(
      { error, provider: params.providerId },
      "[NativeTransport] Reply room lookup failed; refusing the send",
    );
    return { decision: "refused" };
  }
  const facts = context
    ? chatOpsRoomFacts({
        provider: params.providerId as "slack" | "ms-teams",
        context,
        threadId: params.threadId,
      })
    : null;
  if (!facts) {
    if (params.strictDelivery)
      throw new ApiError(
        503,
        "Native review room lookup is unavailable",
        "native_delivery_lookup",
      );
    return { decision: "refused" };
  }
  return authorizeOutbound({
    session: params.session,
    eventId: egressEventId(`reply:${params.messageId}`, params.content),
    facts,
    content: params.content,
    strictDelivery: params.strictDelivery,
  });
}

export async function authorizeEmailReply(params: {
  session: TransportSession;
  messageId: string;
  deliveryId?: string;
  mailbox: string;
  threadId: string;
  content: string;
  resolveRecipients: () => Promise<string[]>;
  strictDelivery?: boolean;
}): Promise<OutboundAuthorization & { recipients?: string[] }> {
  const governance = await transportGovernance(params.session);
  if (governance !== "governed") return { decision: "pass" };
  let recipients: string[];
  try {
    recipients = await params.resolveRecipients();
  } catch (error) {
    if (params.strictDelivery)
      throw new ApiError(
        error instanceof ApiError && [401, 403].includes(error.statusCode)
          ? 403
          : 503,
        "Native review recipient lookup is unavailable",
        error instanceof ApiError && [401, 403].includes(error.statusCode)
          ? "native_delivery_denied"
          : "native_delivery_lookup",
      );
    logger.warn(
      { error, messageId: params.messageId },
      "[NativeTransport] Reply recipient lookup failed; refusing the send",
    );
    return { decision: "refused" };
  }
  if (recipients.length === 0) {
    if (params.strictDelivery)
      throw new ApiError(
        503,
        "Native review recipients are unavailable",
        "native_delivery_lookup",
      );
    return { decision: "refused" };
  }
  const facts = emailRoomFacts({
    mailbox: params.mailbox,
    threadId: params.threadId,
    recipients,
  });
  if (!facts) {
    if (params.strictDelivery)
      throw new ApiError(
        403,
        "Invalid native review recipients",
        "native_delivery_denied",
      );
    return { decision: "refused" };
  }
  const decision = await authorizeOutbound({
    session: params.session,
    eventId: `outlook:${params.deliveryId ?? params.messageId}:reply`,
    facts,
    content: params.content,
    strictDelivery: params.strictDelivery,
  });
  if (decision.decision === "allowed" || decision.decision === "pass") {
    return { ...decision, recipients };
  }
  return decision;
}

export async function admitEmailTurn(params: {
  session: TransportSession;
  messageId: string;
  mailbox: string;
  sourceSenderAddress: string;
  threadId: string;
  body: string;
  history: readonly string[];
  attachments: readonly A2AAttachment[];
}): Promise<ChatOpsAdmission> {
  const governance = await transportGovernance(params.session);
  if (governance !== "governed") return { decision: "pass" };
  const facts = emailRoomFacts({
    mailbox: params.mailbox,
    threadId: params.threadId,
    // The provider envelope establishes the author and this receiving mailbox.
    // It does not grant read access to a separate Reply-To destination.
    recipients: [params.sourceSenderAddress, params.mailbox],
  });
  if (!facts) return { decision: "refused" };
  const admitted = await admitParts({
    session: params.session,
    eventId: `outlook:${params.messageId}`,
    facts,
    parts: inboundParts(params),
  });
  if (admitted.decision === "pass") return { decision: "pass" };
  if (admitted.decision === "refused") return { decision: "refused" };
  const applied = applyAdmittedParts({
    admitted: admitted.parts,
    body: params.body,
    history: params.history,
    attachments: params.attachments,
  });
  if (!applied.ok) return { decision: "refused" };
  return { decision: "admitted", ...applied };
}

/**
 * Active v2 background delivery must name the session that produced the
 * artifact. A file hash is not that session.
 */
export async function backgroundSessionRequired(): Promise<boolean> {
  return (await readGuardrailsV2Activation()) === "active";
}

async function admitParts(params: {
  session: TransportSession;
  eventId: string;
  facts: NativeRoomFacts;
  parts: Array<{ id: string; content: string }>;
}): Promise<
  | { decision: "pass" }
  | { decision: "refused" }
  | { decision: "admitted"; parts: AdmittedPart[] }
> {
  try {
    const admitted: AdmittedPart[] = [];
    const command = params.parts.filter((part) => part.id === "");
    const data = params.parts.filter((part) => part.id !== "");
    for (const parts of [command, data]) {
      if (parts.length === 0) continue;
      const decision = await admitNativeIngress({
        session: toOpenAppaSession(params.session),
        eventId: params.eventId,
        // Membership authenticates the command, not uploaded files or
        // replayed history supplied alongside that command.
        facts:
          parts === data
            ? { ...params.facts, trust: "suspicious" }
            : params.facts,
        parts,
      });
      if (decision.decision === "not_governed") {
        return admitted.length > 0
          ? { decision: "refused" }
          : { decision: "pass" };
      }
      if (decision.decision === "refused") return { decision: "refused" };
      admitted.push(...decision.parts);
    }
    return { decision: "admitted", parts: admitted };
  } catch (error) {
    logger.warn(
      { error, eventId: params.eventId },
      "[NativeTransport] Ingress admission failed closed",
    );
    return { decision: "refused" };
  }
}

export function supportedNativeProvider(
  providerId: string,
): providerId is Exclude<NativeProvider, "outlook"> {
  return (
    providerId === "slack" ||
    providerId === "ms-teams" ||
    providerId === "telegram"
  );
}
