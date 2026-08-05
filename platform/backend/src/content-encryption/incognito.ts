import { createHash, timingSafeEqual } from "node:crypto";
import config from "@/config";
import {
  decryptStringWithKey,
  encryptStringWithKey,
  isContentEnvelope,
} from "@/utils/crypto";

/**
 * Incognito chats: per-conversation content encryption under a browser-held
 * DEK. Free feature, enabled by default; disable with
 * ARCHESTRA_CHAT_INCOGNITO_ENABLED=false.
 *
 * The browser generates a random 32-byte DEK, keeps it in browser storage,
 * and presents it on every request for that conversation via the
 * `x-archestra-incognito-key` header. The server uses it transiently — rows
 * are written as the same `{ __encrypted: "v1:..." }` envelopes the at-rest
 * layer uses, but under the conversation DEK with a conversation-bound AAD,
 * and the raw DEK is never persisted.
 *
 * Enterprise add-on (content-encryption/incognito-escrow.ee.ts): the DEK can
 * additionally be wrapped to an operator-configured RSA escrow public key at
 * creation for break-glass recovery. Without escrow configured, no recoverable
 * copy of the key exists anywhere — only the DEK fingerprint is stored.
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

/** True when incognito chats are offered (on unless explicitly disabled). */
export function isIncognitoChatEnabled(): boolean {
  return config.chatIncognito.enabled;
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
 * Encrypt a message content value under the conversation DEK. The AAD binds
 * the ciphertext to both the column and the conversation, so ciphertext
 * cannot be transplanted between conversations sharing a leaked DEK.
 */
export function encryptIncognitoMessageContent<T>(
  content: T,
  params: { dek: Buffer; conversationId: string },
): unknown {
  if (content === null || content === undefined) return content;
  const envelope = encryptStringWithKey(
    JSON.stringify({ v: content }),
    params.dek,
    incognitoMessageAad(params.conversationId),
  );
  return { __encrypted: envelope };
}

/**
 * Decrypt a message row's content in place under the conversation DEK.
 * Plaintext rows pass through (a conversation toggled through a plaintext
 * era does not exist today, but the tolerance costs nothing and mirrors the
 * at-rest layer). An envelope the DEK cannot open throws.
 */
export function decryptIncognitoMessageRow<T extends object>(
  row: T,
  params: { dek: Buffer; conversationId: string },
): T {
  const target = row as Record<string, unknown>;
  if (!("content" in target) || !isContentEnvelope(target.content)) return row;
  const decrypted = decryptStringWithKey(
    (target.content as { __encrypted: string }).__encrypted,
    params.dek,
    incognitoMessageAad(params.conversationId),
  );
  target.content = (JSON.parse(decrypted) as { v: unknown }).v;
  return row;
}

// === Internal ===

const DEK_LENGTH_BYTES = 32;

function incognitoMessageAad(conversationId: string): string {
  return `messages.content|incognito:${conversationId}`;
}
