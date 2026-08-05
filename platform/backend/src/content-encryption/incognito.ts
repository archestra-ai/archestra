import config from "@/config";
import {
  decryptStringWithKey,
  encryptStringWithKey,
  isContentEnvelope,
} from "@/utils/crypto";
import {
  browserKeyFingerprint,
  browserKeyMatches,
  parseBrowserKeyHeader,
} from "./browser-key";

/**
 * Incognito chats: per-conversation content encryption under a browser-held
 * DEK. Free feature, enabled by default (ARCHESTRA_CHAT_INCOGNITO_ENABLED=false
 * disables it).
 *
 * The browser generates a random 32-byte DEK, keeps it in browser storage,
 * and presents it on every request for that conversation via the
 * `x-archestra-incognito-key` header. The server uses it transiently — rows
 * are written as the same `{ __encrypted: "v1:..." }` envelopes the at-rest
 * layer uses, but under the conversation DEK with a conversation-bound AAD,
 * and the raw DEK is never persisted.
 *
 * Enterprise governance (optional, incognito-escrow.ee.ts): the DEK can be
 * escrowed — wrapped to an operator-configured RSA public key and stored on
 * the conversation row or written to a Vault path — for break-glass
 * recovery by the customer's security team.
 *
 * This is NOT end-to-end encryption: the server sees the DEK and plaintext
 * while serving requests (it must — it forwards content to the LLM provider
 * and runs guardrails). The guarantee is at-rest: no key the platform holds
 * can open these rows. Independent of enterprise content encryption at
 * rest — either, both, or neither can be active.
 *
 * Deliberate envelope-compat property: because incognito envelopes are shaped
 * exactly like at-rest envelopes, the content-encryption backfill sweep
 * treats them as foreign-key envelopes and skips them (see rewriteFor in
 * backfill.ee.ts) — it must never re-wrap them under the server key.
 */

/** Request header carrying the base64url-encoded 32-byte conversation DEK. */
export const INCOGNITO_KEY_HEADER = "x-archestra-incognito-key";

/** True when incognito chats are offered (default on; env-disabled). */
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
  return parseBrowserKeyHeader(headerValue);
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
  return browserKeyFingerprint({
    domain: INCOGNITO_FP_DOMAIN,
    subjectId: conversationId,
    key: dek,
  });
}

/** Constant-time comparison of a stored fingerprint against a presented DEK. */
export function incognitoDekMatches(params: {
  storedFingerprint: string;
  conversationId: string;
  dek: Buffer;
}): boolean {
  return browserKeyMatches({
    storedFingerprint: params.storedFingerprint,
    domain: INCOGNITO_FP_DOMAIN,
    subjectId: params.conversationId,
    key: params.dek,
  });
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

const INCOGNITO_FP_DOMAIN = "archestra-incognito-dek-fp-v1";

function incognitoMessageAad(conversationId: string): string {
  return `messages.content|incognito:${conversationId}`;
}
