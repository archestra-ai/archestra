// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { KeyObject } from "node:crypto";
import config from "@/config";
import type { IncognitoEscrowBlob } from "@/types/conversation";
import { decryptStringWithKey, encryptStringWithKey } from "@/utils/crypto";
import {
  browserKeyFingerprint,
  browserKeyMatches,
  loadEscrowPublicKey,
  parseBrowserKeyHeader,
  wrapBrowserKey,
} from "./browser-key.ee";
import { isContentEnvelope } from "./index.ee";

/**
 * Incognito chats: per-conversation content encryption under a browser-held
 * DEK (enterprise feature).
 *
 * The browser generates a random 32-byte DEK, keeps it in browser storage,
 * and presents it on every request for that conversation via the
 * `x-archestra-incognito-key` header. The server uses it transiently — rows
 * are written as the same `{ __encrypted: "v1:..." }` envelopes the at-rest
 * layer uses, but under the conversation DEK with a conversation-bound AAD,
 * and the raw DEK is never persisted.
 *
 * Enterprise auditability: at creation the DEK is wrapped to an
 * operator-configured RSA public key (ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY)
 * whose private half is held offline by the customer's security team. The
 * wrapped blob is stored on the conversation row; recovering content is an
 * explicit break-glass procedure, not something the platform can do alone.
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

/** True when incognito chats can be offered: EE license + valid escrow key. */
export function isIncognitoChatEnabled(): boolean {
  return Boolean(config.enterpriseFeatures.core && escrowKeyOrNull());
}

/**
 * Boot-time validation, mirroring the content-encryption guard's posture:
 * an operator who configured the escrow key must never silently run with it
 * ignored (bad PEM, too-small key, or missing license).
 */
export function verifyIncognitoChatConfig(): void {
  const pem = config.chatIncognito.escrowPublicKey;
  if (!pem) return;

  if (!config.enterpriseFeatures.core) {
    throw new Error(
      "Incognito chats (ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY) require " +
        "an enterprise license. Unset the variable or contact " +
        "sales@archestra.ai.",
    );
  }
  // Throws with the parse/size problem named.
  loadEscrowKey(pem);
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
 * Wrap a DEK to the escrow public key. RSA-OAEP with an EXPLICIT sha256 —
 * Node's default OAEP hash is SHA-1. The blob is versioned so the offline
 * recovery procedure is unambiguous.
 */
export function wrapIncognitoDek(dek: Buffer): IncognitoEscrowBlob {
  const key = escrowKeyOrNull();
  if (!key) {
    throw new Error(
      "incognito escrow public key is not configured — this is a bug in the " +
        "enablement gating",
    );
  }
  return wrapBrowserKey({ key: dek, escrowKey: key });
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

let cachedEscrowKey: KeyObject | null = null;
let cachedEscrowKeyPem: string | null = null;

function incognitoMessageAad(conversationId: string): string {
  return `messages.content|incognito:${conversationId}`;
}

function escrowKeyOrNull(): KeyObject | null {
  const pem = config.chatIncognito.escrowPublicKey;
  if (!pem) return null;
  if (cachedEscrowKey && cachedEscrowKeyPem === pem) return cachedEscrowKey;
  try {
    cachedEscrowKey = loadEscrowKey(pem);
    cachedEscrowKeyPem = pem;
    return cachedEscrowKey;
  } catch {
    // Invalid key: the boot guard rejects this at startup; treat the feature
    // as disabled rather than half-working if it is somehow reached.
    return null;
  }
}

function loadEscrowKey(pem: string): KeyObject {
  return loadEscrowPublicKey({
    pem,
    envVarName: "ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY",
  });
}
