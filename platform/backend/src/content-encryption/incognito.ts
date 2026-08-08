import { createHash, timingSafeEqual } from "node:crypto";
import type { ConversationContentKey } from "@/types/conversation";
import {
  decryptStringWithKey,
  encryptStringWithKey,
  isContentEnvelope,
} from "@/utils/crypto";
import { isIncognitoEscrowConfigured } from "./incognito-escrow";

/**
 * Incognito chats: per-conversation content encryption under a browser-held
 * DEK, covering both the conversation itself and the audit trail it produces.
 *
 * The browser generates a random 32-byte DEK, keeps it in browser storage,
 * and presents it on every request for that conversation via the
 * `x-archestra-incognito-key` header. The server uses it transiently — rows
 * are written as the same `{ __encrypted: "v1:..." }` envelopes the at-rest
 * layer uses, but under the conversation DEK with a conversation-bound AAD,
 * and the raw DEK is never persisted.
 *
 * Disabled until an operator configures key escrow
 * (ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY, see incognito-escrow.ts).
 * That is deliberate: the audit surfaces are encrypted rather than discarded,
 * so without an escrow copy of the DEK they would be unrecoverable by anyone
 * but the one browser that created them — private, but useless to an auditor.
 * Escrow makes break-glass recovery the answer instead.
 *
 * This is NOT end-to-end encryption: the server sees the DEK and plaintext
 * while serving requests (it must — it forwards content to the LLM provider
 * and runs guardrails). The guarantee is at-rest: no key the platform holds
 * can open these rows.
 *
 * Deliberate envelope-compat property: because incognito envelopes are shaped
 * exactly like at-rest envelopes, the content-encryption backfill sweep
 * treats them as foreign-key envelopes and skips them (see rewriteFor in
 * backfill.ee.ts) — it must never re-wrap them under the server key.
 */

/** Request header carrying the base64url-encoded 32-byte conversation DEK. */
export const INCOGNITO_KEY_HEADER = "x-archestra-incognito-key";

/**
 * True when incognito chats are offered. Configuring an escrow key is the only
 * switch: without one the feature cannot work correctly (see below), so a
 * second flag would only add a way to express the same intent twice.
 */
export function isIncognitoChatEnabled(): boolean {
  return isIncognitoEscrowConfigured();
}

/**
 * Parse the DEK header value. Returns null when the header is absent;
 * throws when present but malformed (not base64url, wrong length) so routes
 * can 400 with a precise message instead of failing GCM later.
 */
export function parseIncognitoDekHeader(
  headerValue: string | undefined,
): Buffer | null {
  if (headerValue === undefined || headerValue === "") return null;
  let dek: Buffer;
  try {
    dek = Buffer.from(headerValue, "base64url");
  } catch {
    throw new Error("incognito key header is not valid base64url");
  }
  if (dek.length !== DEK_LENGTH_BYTES) {
    throw new Error(
      `incognito key must decode to exactly ${DEK_LENGTH_BYTES} bytes`,
    );
  }
  return dek;
}

/**
 * Domain-separated fingerprint of a conversation DEK, stored on the row so a
 * wrong key is rejected up front with a clean error instead of surfacing as
 * scattered GCM failures.
 */
export function incognitoDekFingerprint(
  conversationId: string,
  dek: Buffer,
): string {
  return createHash("sha256")
    .update("archestra-incognito-dek-fp-v1")
    .update(conversationId)
    .update(dek)
    .digest("hex");
}

/** Constant-time comparison of a stored fingerprint against a presented DEK. */
export function incognitoDekMatches(params: {
  storedFingerprint: string;
  conversationId: string;
  dek: Buffer;
}): boolean {
  const presented = Buffer.from(
    incognitoDekFingerprint(params.conversationId, params.dek),
    "hex",
  );
  const stored = Buffer.from(params.storedFingerprint, "hex");
  return (
    stored.length === presented.length && timingSafeEqual(stored, presented)
  );
}

/**
 * Every column that may hold an incognito envelope, and the AAD context that
 * binds ciphertext to it. A superset of the at-rest layer's contexts: incognito
 * also covers the chat-side audit surfaces (errors, tool-execution claims,
 * active-run replay payloads), which have no at-rest encryption.
 *
 * The spellings deliberately match `ContentEncryptionContext` where the two
 * overlap, so a column's AAD context reads the same in both layers.
 */
export type IncognitoContentContext =
  | "messages.content"
  | "interactions.request"
  | "interactions.processed_request"
  | "interactions.response"
  | "interactions.dual_llm_analyses"
  | "interactions.unsafe_context_boundary"
  | "mcp_tool_calls.tool_call"
  | "mcp_tool_calls.tool_result"
  | "conversation_chat_errors.error"
  | "chat_tool_execution_claims.result"
  | "chat_active_run_events.payloads";

/**
 * A resolved authorization to write one conversation's incognito AUDIT
 * content (interactions, MCP tool calls, chat errors, claims, replay events).
 *
 * Structurally a {@link ConversationContentKey}, but carries a stronger
 * precondition: it is only ever produced by `resolveIncognitoAuditContext`,
 * which additionally proves the conversation has an escrow record. That makes
 * every row written under it recoverable by break-glass — the property that
 * lets these surfaces be encrypted rather than redacted.
 */
export type IncognitoAuditContext = ConversationContentKey;

/**
 * Encrypt a value under the conversation DEK for a specific column. The AAD
 * binds the ciphertext to both the column and the conversation, so ciphertext
 * cannot be transplanted between columns, or between conversations sharing a
 * leaked DEK.
 */
export function encryptIncognitoValue<T>(
  value: T,
  params: IncognitoAuditContext & { context: IncognitoContentContext },
): unknown {
  if (value === null || value === undefined) return value;
  const envelope = encryptStringWithKey(
    // Wrapped so arrays and primitives round-trip: the envelope always
    // decrypts to `{"v": <original>}`, matching the at-rest layer.
    JSON.stringify({ v: value }),
    params.dek,
    incognitoAad(params.context, params.conversationId),
  );
  return { __encrypted: envelope };
}

/**
 * Decrypt one incognito-encrypted value. Non-envelope values pass through
 * unchanged (a column may legitimately hold plaintext or the fail-closed
 * redaction marker). An envelope this DEK cannot open throws — callers that
 * must tolerate that surface a locked sentinel instead of calling here.
 */
export function decryptIncognitoValue(
  value: unknown,
  params: IncognitoAuditContext & { context: IncognitoContentContext },
): unknown {
  if (!isContentEnvelope(value)) return value;
  const decrypted = decryptStringWithKey(
    (value as { __encrypted: string }).__encrypted,
    params.dek,
    incognitoAad(params.context, params.conversationId),
  );
  return (JSON.parse(decrypted) as { v: unknown }).v;
}

/**
 * Encrypt a message content value under the conversation DEK.
 */
export function encryptIncognitoMessageContent<T>(
  content: T,
  params: IncognitoAuditContext,
): unknown {
  return encryptIncognitoValue(content, {
    ...params,
    context: "messages.content",
  });
}

/**
 * Decrypt a message row's content in place under the conversation DEK.
 * Plaintext rows pass through (a conversation toggled through a plaintext
 * era does not exist today, but the tolerance costs nothing and mirrors the
 * at-rest layer). An envelope the DEK cannot open throws.
 */
export function decryptIncognitoMessageRow<T extends object>(
  row: T,
  params: IncognitoAuditContext,
): T {
  const target = row as Record<string, unknown>;
  if (!("content" in target) || !isContentEnvelope(target.content)) return row;
  target.content = decryptIncognitoValue(target.content, {
    ...params,
    context: "messages.content",
  });
  return row;
}

// === Internal ===

const DEK_LENGTH_BYTES = 32;

function incognitoAad(
  context: IncognitoContentContext,
  conversationId: string,
): string {
  return `${context}|incognito:${conversationId}`;
}
