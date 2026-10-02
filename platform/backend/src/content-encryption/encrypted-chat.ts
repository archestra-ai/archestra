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
import { isEncryptedChatEscrowConfigured } from "./encrypted-chat-escrow";

/**
 * Encrypted chats: per-conversation content encryption under a browser-held
 * DEK, covering both the conversation itself and the audit trail it produces.
 *
 * The browser generates a random 32-byte DEK, keeps it in browser storage,
 * and presents it on every request for that conversation via the
 * `x-archestra-encrypted-chat-key` header. The server uses it transiently — rows
 * are written as the same `{ __encrypted: "v1:..." }` envelopes the at-rest
 * layer uses, but under the conversation DEK with a conversation-bound AAD,
 * and the raw DEK is never persisted.
 *
 * Disabled until an operator configures key escrow
 * (ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY, see encrypted-chat-escrow.ts).
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
 * Deliberate envelope-compat property: because encrypted-chat envelopes are shaped
 * exactly like at-rest envelopes, the content-encryption backfill sweep
 * treats them as foreign-key envelopes and skips them (see rewriteFor in
 * backfill.ee.ts) — it must never re-wrap them under the server key.
 */

/** Request header carrying the base64url-encoded 32-byte conversation DEK. */
export const ENCRYPTED_CHAT_KEY_HEADER = "x-archestra-encrypted-chat-key";

/**
 * The header's former names ("locked chat", then "incognito"), still accepted
 * on read.
 *
 * A browser tab loaded before a rename keeps sending the old header, and the
 * key it carries is the only copy of that conversation's DEK outside escrow —
 * dropping it would show the user a locked tombstone for their own chat until
 * they reloaded. Read-only: nothing emits these spellings.
 */
export const LEGACY_ENCRYPTED_CHAT_KEY_HEADERS = [
  "x-archestra-locked-chat-key",
  "x-archestra-incognito-key",
] as const;

/**
 * True when encrypted chats are offered. Configuring an escrow key is the only
 * switch: without one the feature cannot work correctly (see below), so a
 * second flag would only add a way to express the same intent twice.
 */
export function isEncryptedChatEnabled(): boolean {
  return isEncryptedChatEscrowConfigured();
}

/**
 * Parse the DEK header value. Returns null when the header is absent;
 * throws when present but malformed (not base64url, wrong length) so routes
 * can 400 with a precise message instead of failing GCM later.
 */
export function parseEncryptedChatDekHeader(
  headerValue: string | undefined,
): Buffer | null {
  if (headerValue === undefined || headerValue === "") return null;
  let dek: Buffer;
  try {
    dek = Buffer.from(headerValue, "base64url");
  } catch {
    throw new Error("encrypted chat key header is not valid base64url");
  }
  if (dek.length !== DEK_LENGTH_BYTES) {
    throw new Error(
      `encrypted chat key must decode to exactly ${DEK_LENGTH_BYTES} bytes`,
    );
  }
  return dek;
}

/**
 * Domain-separated fingerprint of a conversation DEK, stored on the row so a
 * wrong key is rejected up front with a clean error instead of surfacing as
 * scattered GCM failures.
 */
export function encryptedChatDekFingerprint(
  conversationId: string,
  dek: Buffer,
): string {
  return (
    createHash("sha256")
      // FROZEN. This is a hashed-in domain separator, not a name: every
      // fingerprint already stored was computed with this exact string, and
      // changing it would make every existing encrypted chat reject its own key.
      // It keeps the feature's former spelling ("incognito") deliberately.
      .update("archestra-incognito-dek-fp-v1")
      .update(conversationId)
      .update(dek)
      .digest("hex")
  );
}

/** Constant-time comparison of a stored fingerprint against a presented DEK. */
export function encryptedChatDekMatches(params: {
  storedFingerprint: string;
  conversationId: string;
  dek: Buffer;
}): boolean {
  const presented = Buffer.from(
    encryptedChatDekFingerprint(params.conversationId, params.dek),
    "hex",
  );
  const stored = Buffer.from(params.storedFingerprint, "hex");
  return (
    stored.length === presented.length && timingSafeEqual(stored, presented)
  );
}

/**
 * Every column that may hold an encrypted-chat envelope, and the AAD context that
 * binds ciphertext to it. A superset of the at-rest layer's contexts: encrypted-chat
 * also covers the chat-side audit surfaces (errors, tool-execution claims,
 * active-run replay payloads), which have no at-rest encryption.
 *
 * The spellings deliberately match `ContentEncryptionContext` where the two
 * overlap, so a column's AAD context reads the same in both layers.
 */
export type EncryptedChatContentContext =
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
 * A resolved authorization to write one conversation's encrypted-chat AUDIT
 * content (interactions, MCP tool calls, chat errors, claims, replay events).
 *
 * Structurally a {@link ConversationContentKey}, but carries a stronger
 * precondition: it is only ever produced by `resolveEncryptedChatAuditContext`,
 * which additionally proves the conversation has an escrow record. That makes
 * every row written under it recoverable by break-glass — the property that
 * lets these surfaces be encrypted rather than redacted.
 */
export type EncryptedChatAuditContext = ConversationContentKey;

/**
 * Encrypt a value under the conversation DEK for a specific column. The AAD
 * binds the ciphertext to both the column and the conversation, so ciphertext
 * cannot be transplanted between columns, or between conversations sharing a
 * leaked DEK.
 */
export function encryptEncryptedChatValue<T>(
  value: T,
  params: EncryptedChatAuditContext & { context: EncryptedChatContentContext },
): unknown {
  if (value === null || value === undefined) return value;
  const envelope = encryptStringWithKey(
    // Wrapped so arrays and primitives round-trip: the envelope always
    // decrypts to `{"v": <original>}`, matching the at-rest layer.
    JSON.stringify({ v: value }),
    params.dek,
    encryptedChatAad(params.context, params.conversationId),
  );
  return { __encrypted: envelope };
}

/**
 * Decrypt one encrypted-chat-encrypted value. Non-envelope values pass through
 * unchanged (a column may legitimately hold plaintext or the fail-closed
 * redaction marker). An envelope this DEK cannot open throws — callers that
 * must tolerate that surface a locked sentinel instead of calling here.
 */
export function decryptEncryptedChatValue(
  value: unknown,
  params: EncryptedChatAuditContext & { context: EncryptedChatContentContext },
): unknown {
  if (!isContentEnvelope(value)) return value;
  const decrypted = decryptStringWithKey(
    (value as { __encrypted: string }).__encrypted,
    params.dek,
    encryptedChatAad(params.context, params.conversationId),
  );
  return (JSON.parse(decrypted) as { v: unknown }).v;
}

/**
 * Encrypt a message content value under the conversation DEK.
 */
export function encryptEncryptedChatMessageContent<T>(
  content: T,
  params: EncryptedChatAuditContext,
): unknown {
  return encryptEncryptedChatValue(content, {
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
export function decryptEncryptedChatMessageRow<T extends object>(
  row: T,
  params: EncryptedChatAuditContext,
): T {
  const target = row as Record<string, unknown>;
  if (!("content" in target) || !isContentEnvelope(target.content)) return row;
  target.content = decryptEncryptedChatValue(target.content, {
    ...params,
    context: "messages.content",
  });
  return row;
}

/**
 * Encrypt a bare string for a TEXT column (as opposed to
 * {@link encryptEncryptedChatValue}, which wraps a JSON value in an
 * `{ __encrypted }` object for a JSONB one). Returns the bare `v1:` envelope,
 * which is what the column then holds.
 */
export function encryptEncryptedChatText(
  value: string,
  params: EncryptedChatAuditContext & { context: EncryptedChatContentContext },
): string {
  return encryptStringWithKey(
    value,
    params.dek,
    encryptedChatAad(params.context, params.conversationId),
  );
}

/**
 * Decrypt a TEXT column written by {@link encryptEncryptedChatText}. A value that
 * is not an envelope passes through unchanged, so a column written before the
 * chat was encrypted still reads.
 */
export function decryptEncryptedChatText(
  value: string,
  params: EncryptedChatAuditContext & { context: EncryptedChatContentContext },
): string {
  if (!isEncryptedEnvelope(value)) return value;
  return decryptStringWithKey(
    value,
    params.dek,
    encryptedChatAad(params.context, params.conversationId),
  );
}

/**
 * Encrypt raw bytes (an attachment's file data) under the conversation DEK.
 * Uses the compact binary envelope rather than the string one: these payloads
 * run to megabytes, where base64's ~33% inflation is a real storage cost.
 */
export function encryptEncryptedChatBytes(
  value: Buffer,
  params: EncryptedChatAuditContext & { context: EncryptedChatContentContext },
): Buffer {
  return encryptBytesWithKey(
    value,
    params.dek,
    encryptedChatAad(params.context, params.conversationId),
  );
}

/** Decrypt bytes written by {@link encryptEncryptedChatBytes}. */
export function decryptEncryptedChatBytes(
  value: Buffer,
  params: EncryptedChatAuditContext & { context: EncryptedChatContentContext },
): Buffer {
  return decryptBytesWithKey(
    value,
    params.dek,
    encryptedChatAad(params.context, params.conversationId),
  );
}

/**
 * Dedup key for an attachment in an encrypted chat: an HMAC of the bytes under the
 * conversation DEK rather than a bare SHA-256 of them.
 *
 * The plain hash is a fingerprint anyone can recompute, so a stored one lets a
 * reader of the database confirm a guess — "is this the layoff spreadsheet I
 * already have a copy of?" — about a chat whose bytes they cannot read. Keying
 * it under the DEK keeps the property the column exists for (same bytes in the
 * same conversation collide, so re-sent history reuses one row) and removes the
 * one it was never meant to have.
 */
export function encryptedChatContentHash(
  value: Buffer,
  params: EncryptedChatAuditContext,
): string {
  return createHmac("sha256", params.dek)
    .update("archestra-locked-chat-attachment-hash-v1")
    .update(params.conversationId)
    .update(value)
    .digest("hex");
}

// === Internal ===

const DEK_LENGTH_BYTES = 32;

function encryptedChatAad(
  context: EncryptedChatContentContext,
  conversationId: string,
): string {
  // FROZEN, for the same reason as the fingerprint domain separator above:
  // this string is authenticated into every envelope already written, so
  // changing it would make all existing encrypted-chat ciphertext undecryptable.
  return `${context}|incognito:${conversationId}`;
}
