import {
  INCOGNITO_REDACTED_MARKER,
  type InteractionSource,
  TimeInMs,
} from "@archestra/shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import {
  type IncognitoAuditContext,
  incognitoDekMatches,
} from "@/content-encryption/incognito";
import logger from "@/logging";
import { ConversationModel } from "@/models";
import type {
  InsertInteraction,
  InteractionRequest,
  InteractionResponse,
} from "@/types";
import { isLoopbackAddress } from "@/utils/network";

/**
 * LLM-proxy side of incognito chats: decide how a request's stored audit
 * content must be handled, and build the fallback redacted record.
 *
 * The normal outcome for an incognito session is `encrypt` — the interaction
 * is stored under the conversation's browser-held key, keeping a full,
 * break-glass-recoverable audit trail. `redact` is the fail-closed safety net
 * for the cases where encryption cannot be done correctly (no key presented,
 * key does not match the conversation, no escrow record, lookup failure); it
 * loses content rather than risking a plaintext write or an unrecoverable one.
 */

/**
 * Marker persisted in place of conversation content when incognito content
 * cannot be encrypted. Re-exported from the shared module so the UI matches on
 * the same shape, and so it stays distinguishable from the LOCKED sentinel —
 * this one means "never stored", not "stored and recoverable".
 */
export { INCOGNITO_REDACTED_MARKER };

/**
 * How this request's audit content must be stored.
 * - `none`: not an incognito session; store normally (server-key at-rest rules apply).
 * - `encrypt`: store under the conversation DEK, stamped with the discriminator.
 * - `redact`: fail-closed; store the redaction marker.
 */
export type IncognitoAuditDisposition =
  | { kind: "none" }
  | { kind: "encrypt"; audit: IncognitoAuditContext }
  | { kind: "redact" };

/** TTL for positive incognito lookups; the flag is immutable per conversation. */
const INCOGNITO_SESSION_CACHE_TTL_MS = TimeInMs.Minute;

/**
 * Resolve how this proxy request's audit content must be stored.
 *
 * Session detection is server-derived — never trusted from spoofable public
 * headers alone: only requests that arrived over the loopback path the in-app
 * chat uses (source === "chat" is set by the chat backend on its in-process
 * proxy call, and the session id equals the conversation id there) qualify for
 * the lookup, and the conversation must be owned by the request's user.
 *
 * The DEK is additive to those checks, never a replacement for them: a
 * presented key is only honoured after ownership is established, and only if
 * it matches the conversation's stored fingerprint. The residual risk is DEK
 * *disclosure*, not forgery — a correct 256-bit DEK is unforgeable, and
 * whoever holds one can already unlock the conversation itself.
 *
 * FAIL CLOSED: any failure to establish an encryptable context for an
 * incognito session yields `redact`, never a plaintext write. A lookup error
 * is treated as incognito for the same reason.
 */
export async function resolveIncognitoAuditContext(params: {
  source: InteractionSource;
  requestIp: string | undefined;
  sessionId: string | null | undefined;
  userId: string | undefined;
  dek: Buffer | null;
}): Promise<IncognitoAuditDisposition> {
  const { source, requestIp, sessionId, userId, dek } = params;
  // "chat" plus chat:* subrequests (e.g. chat:tool_call_repair — a repair
  // prompt carries the same conversation content as the turn it repairs).
  // NOT chatops:* — those are unrelated messaging-channel sessions.
  if (
    (source !== "chat" && !source?.startsWith("chat:")) ||
    !sessionId ||
    !userId ||
    !isLoopbackAddress(requestIp)
  ) {
    return { kind: "none" };
  }

  const cacheKey =
    `${CacheKey.IncognitoChatSession}-${sessionId}:${userId}` as const;
  try {
    // Shape-guarded rather than trusted: a cache entry written by a different
    // build must never be coerced into "not incognito" (that would write
    // plaintext). Anything unrecognized is re-derived from the database.
    const cached = asSessionFacts(await cacheManager.get<unknown>(cacheKey));
    const facts =
      cached ??
      (await ConversationModel.getIncognitoAuditInfoOwnedBy({
        id: sessionId,
        userId,
      }));

    if (!facts?.incognito) return { kind: "none" };

    if (!cached) {
      // Positive results only: the flag is immutable once set at creation, so
      // a cached incognito record can never go stale; a negative could mask a
      // race with conversation creation and must always be re-derived.
      await cacheManager.set(
        cacheKey,
        {
          incognito: true,
          incognitoDekFingerprint: facts.incognitoDekFingerprint,
          hasEscrow: facts.hasEscrow,
        } satisfies IncognitoSessionFacts,
        INCOGNITO_SESSION_CACHE_TTL_MS,
      );
    }

    return dispositionFor({ facts, dek, conversationId: sessionId });
  } catch (error) {
    logger.warn(
      { error, sessionId },
      "Incognito chat session lookup failed; failing closed (redacting interaction content)",
    );
    return { kind: "redact" };
  }
}

/**
 * Replace the content-bearing fields of an interaction record with the
 * incognito redaction marker (or null where the column is nullable), keeping
 * every usage/cost/model/session metadata field intact so usage accounting
 * and cost limits keep working.
 */
export function redactIncognitoInteraction(
  record: InsertInteraction,
): InsertInteraction {
  return {
    ...record,
    request: INCOGNITO_REDACTED_MARKER as unknown as InteractionRequest,
    processedRequest: null,
    response: INCOGNITO_REDACTED_MARKER as unknown as InteractionResponse,
    dualLlmAnalyses: null,
    unsafeContextBoundary: null,
  };
}

// === Internal ===

type IncognitoSessionFacts = {
  incognito: boolean;
  incognitoDekFingerprint: string | null;
  hasEscrow: boolean;
};

function asSessionFacts(value: unknown): IncognitoSessionFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<IncognitoSessionFacts>;
  if (
    typeof candidate.incognito !== "boolean" ||
    typeof candidate.hasEscrow !== "boolean"
  ) {
    return null;
  }
  return {
    incognito: candidate.incognito,
    incognitoDekFingerprint: candidate.incognitoDekFingerprint ?? null,
    hasEscrow: candidate.hasEscrow,
  };
}

function dispositionFor(params: {
  facts: IncognitoSessionFacts;
  dek: Buffer | null;
  conversationId: string;
}): IncognitoAuditDisposition {
  const { facts, dek, conversationId } = params;

  // No key on this request (e.g. a background subrequest that did not carry
  // the header): nothing to encrypt under.
  if (!dek) return { kind: "redact" };

  // No escrow record means no one could ever open what we wrote. Redaction is
  // the lesser loss: it is at least an honest, uniform gap.
  if (!facts.hasEscrow) return { kind: "redact" };

  const storedFingerprint = facts.incognitoDekFingerprint;
  if (
    !storedFingerprint ||
    !incognitoDekMatches({ storedFingerprint, conversationId, dek })
  ) {
    return { kind: "redact" };
  }

  return { kind: "encrypt", audit: { dek, conversationId } };
}
