import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ConversationContentKey } from "@/types/conversation";
import {
  decryptBytesWithKey,
  decryptStringWithKey,
  encryptBytesWithKey,
  encryptStringWithKey,
  isContentEnvelope,
  isEncryptedEnvelope,
} from "@/utils/crypto";
import { isLockedChatEscrowConfigured } from "./locked-chat-escrow";

/**
 * Locked chats: per-conversation content encryption under a browser-held
 * DEK, covering both the conversation itself and the audit trail it produces.
 *
 * The browser generates a random 32-byte DEK, keeps it in browser storage,
 * and presents it on every request for that conversation via the
 * `x-archestra-locked-chat-key` header. The server uses it transiently — rows
 * are written as the same `{ __encrypted: "v1:..." }` envelopes the at-rest
 * layer uses, but under the conversation DEK with a conversation-bound AAD,
 * and the raw DEK is never persisted.
 *
 * Disabled until an operator configures key escrow
 * (ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY, see locked-chat-escrow.ts).
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
 * Deliberate envelope-compat property: because locked-chat envelopes are shaped
 * exactly like at-rest envelopes, the content-encryption backfill sweep
 * treats them as foreign-key envelopes and skips them (see rewriteFor in
 * backfill.ee.ts) — it must never re-wrap them under the server key.
 */

/** Request header carrying the base64url-encoded 32-byte conversation DEK. */
export const LOCKED_CHAT_KEY_HEADER = "x-archestra-locked-chat-key";

/**
 * The header's former name, still accepted on read.
 *
 * A browser tab loaded before this rename keeps sending the old header, and
 * the key it carries is the only copy of that conversation's DEK outside
 * escrow — dropping it would show the user a locked tombstone for their own
 * chat until they reloaded. Read-only: nothing emits this spelling.
 */
export const LEGACY_LOCKED_CHAT_KEY_HEADER = "x-archestra-incognito-key";

/**
 * True when locked chats are offered. Configuring an escrow key is the only
 * switch: without one the feature cannot work correctly (see below), so a
 * second flag would only add a way to express the same intent twice.
 */
export function isLockedChatEnabled(): boolean {
  return isLockedChatEscrowConfigured();
}

/**
 * Parse the DEK header value. Returns null when the header is absent;
 * throws when present but malformed (not base64url, wrong length) so routes
 * can 400 with a precise message instead of failing GCM later.
 */
export function parseLockedChatDekHeader(
  headerValue: string | undefined,
): Buffer | null {
  if (headerValue === undefined || headerValue === "") return null;
  let dek: Buffer;
  try {
    dek = Buffer.from(headerValue, "base64url");
  } catch {
    throw new Error("locked chat key header is not valid base64url");
  }
  if (dek.length !== DEK_LENGTH_BYTES) {
    throw new Error(
      `locked chat key must decode to exactly ${DEK_LENGTH_BYTES} bytes`,
    );
  }
  return dek;
}

/**
 * Domain-separated fingerprint of a conversation DEK, stored on the row so a
 * wrong key is rejected up front with a clean error instead of surfacing as
 * scattered GCM failures.
 */
export function lockedChatDekFingerprint(
  conversationId: string,
  dek: Buffer,
): string {
  return (
    createHash("sha256")
      // FROZEN. This is a hashed-in domain separator, not a name: every
      // fingerprint already stored was computed with this exact string, and
      // changing it would make every existing locked chat reject its own key.
      // It keeps the feature's former spelling ("incognito") deliberately.
      .update("archestra-incognito-dek-fp-v1")
      .update(conversationId)
      .update(dek)
      .digest("hex")
  );
}

/** Constant-time comparison of a stored fingerprint against a presented DEK. */
export function lockedChatDekMatches(params: {
  storedFingerprint: string;
  conversationId: string;
  dek: Buffer;
}): boolean {
  const presented = Buffer.from(
    lockedChatDekFingerprint(params.conversationId, params.dek),
    "hex",
  );
  const stored = Buffer.from(params.storedFingerprint, "hex");
  return (
    stored.length === presented.length && timingSafeEqual(stored, presented)
  );
}

/**
 * Every column that may hold a locked-chat envelope, and the AAD context that
 * binds ciphertext to it. A superset of the at-rest layer's contexts: locked-chat
 * also covers the chat-side audit surfaces (errors, tool-execution claims,
 * active-run replay payloads), which have no at-rest encryption.
 *
 * The spellings deliberately match `ContentEncryptionContext` where the two
 * overlap, so a column's AAD context reads the same in both layers.
 */
export type LockedChatContentContext =
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
  | "chat_active_run_events.payloads"
  | "conversation_attachments.file_data"
  | "conversation_attachments.original_name"
  | "conversation_attachments.text_preview";

/**
 * A resolved authorization to write one conversation's locked-chat AUDIT
 * content (interactions, MCP tool calls, chat errors, claims, replay events).
 *
 * Structurally a {@link ConversationContentKey}, but carries a stronger
 * precondition: it is only ever produced by `resolveLockedChatAuditContext`,
 * which additionally proves the conversation has an escrow record. That makes
 * every row written under it recoverable by break-glass — the property that
 * lets these surfaces be encrypted rather than redacted.
 */
export type LockedChatAuditContext = ConversationContentKey;

/**
 * Encrypt a value under the conversation DEK for a specific column. The AAD
 * binds the ciphertext to both the column and the conversation, so ciphertext
 * cannot be transplanted between columns, or between conversations sharing a
 * leaked DEK.
 */
export function encryptLockedChatValue<T>(
  value: T,
  params: LockedChatAuditContext & { context: LockedChatContentContext },
): unknown {
  if (value === null || value === undefined) return value;
  const envelope = encryptStringWithKey(
    // Wrapped so arrays and primitives round-trip: the envelope always
    // decrypts to `{"v": <original>}`, matching the at-rest layer.
    JSON.stringify({ v: value }),
    params.dek,
    lockedChatAad(params.context, params.conversationId),
  );
  return { __encrypted: envelope };
}

/**
 * Decrypt one locked-chat-encrypted value. Non-envelope values pass through
 * unchanged (a column may legitimately hold plaintext or the fail-closed
 * redaction marker). An envelope this DEK cannot open throws — callers that
 * must tolerate that surface a locked sentinel instead of calling here.
 */
export function decryptLockedChatValue(
  value: unknown,
  params: LockedChatAuditContext & { context: LockedChatContentContext },
): unknown {
  if (!isContentEnvelope(value)) return value;
  const decrypted = decryptStringWithKey(
    (value as { __encrypted: string }).__encrypted,
    params.dek,
    lockedChatAad(params.context, params.conversationId),
  );
  return (JSON.parse(decrypted) as { v: unknown }).v;
}

/**
 * Encrypt a message content value under the conversation DEK.
 */
export function encryptLockedChatMessageContent<T>(
  content: T,
  params: LockedChatAuditContext,
): unknown {
  return encryptLockedChatValue(content, {
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
export function decryptLockedChatMessageRow<T extends object>(
  row: T,
  params: LockedChatAuditContext,
): T {
  const target = row as Record<string, unknown>;
  if (!("content" in target) || !isContentEnvelope(target.content)) return row;
  target.content = decryptLockedChatValue(target.content, {
    ...params,
    context: "messages.content",
  });
  return row;
}

/**
 * Encrypt a bare string for a TEXT column (as opposed to
 * {@link encryptLockedChatValue}, which wraps a JSON value in an
 * `{ __encrypted }` object for a JSONB one). Returns the bare `v1:` envelope,
 * which is what the column then holds.
 */
export function encryptLockedChatText(
  value: string,
  params: LockedChatAuditContext & { context: LockedChatContentContext },
): string {
  return encryptStringWithKey(
    value,
    params.dek,
    lockedChatAad(params.context, params.conversationId),
  );
}

/**
 * Decrypt a TEXT column written by {@link encryptLockedChatText}. A value that
 * is not an envelope passes through unchanged, so a column written before the
 * chat was locked still reads.
 */
export function decryptLockedChatText(
  value: string,
  params: LockedChatAuditContext & { context: LockedChatContentContext },
): string {
  if (!isEncryptedEnvelope(value)) return value;
  return decryptStringWithKey(
    value,
    params.dek,
    lockedChatAad(params.context, params.conversationId),
  );
}

/**
 * Encrypt raw bytes (an attachment's file data) under the conversation DEK.
 * Uses the compact binary envelope rather than the string one: these payloads
 * run to megabytes, where base64's ~33% inflation is a real storage cost.
 */
export function encryptLockedChatBytes(
  value: Buffer,
  params: LockedChatAuditContext & { context: LockedChatContentContext },
): Buffer {
  return encryptBytesWithKey(
    value,
    params.dek,
    lockedChatAad(params.context, params.conversationId),
  );
}

/** Decrypt bytes written by {@link encryptLockedChatBytes}. */
export function decryptLockedChatBytes(
  value: Buffer,
  params: LockedChatAuditContext & { context: LockedChatContentContext },
): Buffer {
  return decryptBytesWithKey(
    value,
    params.dek,
    lockedChatAad(params.context, params.conversationId),
  );
}

/**
 * Dedup key for an attachment in a locked chat: an HMAC of the bytes under the
 * conversation DEK rather than a bare SHA-256 of them.
 *
 * The plain hash is a fingerprint anyone can recompute, so a stored one lets a
 * reader of the database confirm a guess — "is this the layoff spreadsheet I
 * already have a copy of?" — about a chat whose bytes they cannot read. Keying
 * it under the DEK keeps the property the column exists for (same bytes in the
 * same conversation collide, so re-sent history reuses one row) and removes the
 * one it was never meant to have.
 */
export function lockedChatContentHash(
  value: Buffer,
  params: LockedChatAuditContext,
): string {
  return createHmac("sha256", params.dek)
    .update("archestra-locked-chat-attachment-hash-v1")
    .update(params.conversationId)
    .update(value)
    .digest("hex");
}

// === Internal ===

const DEK_LENGTH_BYTES = 32;

function lockedChatAad(
  context: LockedChatContentContext,
  conversationId: string,
): string {
  // FROZEN, for the same reason as the fingerprint domain separator above:
  // this string is authenticated into every envelope already written, so
  // changing it would make all existing locked-chat ciphertext undecryptable.
  return `${context}|incognito:${conversationId}`;
}
