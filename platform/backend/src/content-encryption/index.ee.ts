// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createHash } from "node:crypto";
import config from "@/config";
import {
  decryptStringWithKey,
  deriveKeyFromSecret,
  encryptStringWithKey,
  isContentEnvelope,
} from "@/utils/crypto";

/**
 * Enterprise content encryption at rest for LLM interaction payloads and chat
 * message content.
 *
 * Values are encrypted at the model layer into the existing jsonb columns as
 * `{ __encrypted: "v1:..." }` envelopes; reads transparently decrypt and pass
 * plaintext rows through untouched (rows the backfill has not reached yet).
 * Each envelope is AAD-bound to its `"<table>.<column>"` context, so a
 * database-level writer cannot transplant a valid ciphertext between columns
 * or tables.
 *
 * Key model:
 * - ARCHESTRA_CONTENT_ENCRYPTION_SECRET — the CURRENT key; setting it turns
 *   encrypted WRITES on (enterprise license required, asserted at boot).
 * - ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS — an ADDITIONAL decrypt-only
 *   key. Reads accept envelopes under either key whenever either is set. This
 *   makes enabling and rotation safe two-rollout procedures on a rolling
 *   deployment: distribute the new key to every replica as decrypt-capable
 *   first, then activate it for writes.
 *
 * Both keys are HKDF-derived with a content-specific info string, so they are
 * unrelated to the stored-secrets key even if an operator reuses a secret.
 */

/** True when encrypted WRITES are active (current secret present). */
export function isContentEncryptionEnabled(): boolean {
  return Boolean(config.contentEncryption.secret);
}

/** True when reads must tolerate envelopes (either key present). */
export function isContentDecryptionAvailable(): boolean {
  return Boolean(
    config.contentEncryption.secret || config.contentEncryption.secretPrevious,
  );
}

/**
 * Contexts bind ciphertext to its storage location via AAD. One entry per
 * encrypted column.
 */
export type ContentEncryptionContext =
  | "interactions.request"
  | "interactions.processed_request"
  | "interactions.response"
  | "interactions.dual_llm_analyses"
  | "interactions.unsafe_context_boundary"
  | "messages.content"
  | "mcp_tool_calls.tool_call"
  | "mcp_tool_calls.tool_result";

/**
 * Encrypt an arbitrary JSON value for storage. Returns the value unchanged
 * when content encryption is disabled or the value is null/undefined.
 */
export function encryptContentValue<T>(
  value: T,
  context: ContentEncryptionContext,
): T | ContentEnvelope {
  if (!isContentEncryptionEnabled()) return value;
  if (value === null || value === undefined) return value;

  const envelope = encryptStringWithKey(
    // Wrapped so arrays and primitives round-trip: the envelope always
    // decrypts to `{"v": <original>}`.
    JSON.stringify({ v: value }),
    getCurrentKey(),
    context,
  );
  return { __encrypted: envelope };
}

/**
 * Decrypt a stored value. Plaintext rows (no strict `v1:` envelope) pass
 * through untouched. Envelopes are tried under the current key, then the
 * previous key. An envelope that no configured key can open throws — serving
 * ciphertext as content would corrupt every consumer downstream.
 */
export function decryptContentValue<T>(
  value: T | ContentEnvelope,
  context: ContentEncryptionContext,
): T {
  if (!isContentEnvelope(value)) return value as T;

  const keys = availableKeys();
  if (keys.length === 0) {
    throw new Error(
      `Encrypted content found in ${context} but no ` +
        "ARCHESTRA_CONTENT_ENCRYPTION_SECRET is configured. Content " +
        "encryption was enabled on this database; restore the key to read it.",
    );
  }

  let lastError: unknown;
  for (const key of keys) {
    try {
      const decrypted = decryptStringWithKey(value.__encrypted, key, context);
      return (JSON.parse(decrypted) as { v: T }).v;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Failed to decrypt ${context}: neither the current nor the previous ` +
      "content encryption key can open this value (wrong key, or the row " +
      "was written under a key that has been dropped)",
    { cause: lastError },
  );
}

/**
 * True when the stored value can only be opened by the PREVIOUS key — i.e.
 * the backfill must re-encrypt it under the current key after a rotation.
 * False for plaintext, current-key envelopes, and unreadable envelopes.
 */
export function isContentUnderPreviousKey(
  value: unknown,
  context: ContentEncryptionContext,
): boolean {
  if (!isContentEnvelope(value)) return false;
  if (decryptsWith(value.__encrypted, currentKeyOrNull(), context)) {
    return false;
  }
  return decryptsWith(value.__encrypted, previousKeyOrNull(), context);
}

/**
 * Fingerprint identifying the current content key for backfill bookkeeping —
 * a one-way hash over the DERIVED key, never key material.
 */
export function contentKeyFingerprint(): string {
  return createHash("sha256")
    .update("archestra-content-key-fingerprint-v1")
    .update(getCurrentKey())
    .digest("hex")
    .slice(0, 32);
}

/**
 * Strict envelope-object check — the implementation lives in `@/utils/crypto`
 * (AGPL: envelope detection is generic); re-exported so existing enterprise
 * importers keep their path.
 */
export { isContentEnvelope } from "@/utils/crypto";

/**
 * Reset derived-key caches after mutating config in tests.
 * @public — exported for testability
 */
export function _resetContentKeys(): void {
  cachedCurrentKey = null;
  cachedPreviousKey = null;
}

// === Internal ===

type ContentEnvelope = { __encrypted: string };

const CONTENT_HKDF_INFO = "archestra-content-encryption-v1";

let cachedCurrentKey: Buffer | null = null;
let cachedPreviousKey: Buffer | null = null;

function getCurrentKey(): Buffer {
  const key = currentKeyOrNull();
  if (!key) {
    throw new Error(
      "ARCHESTRA_CONTENT_ENCRYPTION_SECRET is not configured but content " +
        "encryption was invoked — this is a bug in the enablement gating",
    );
  }
  return key;
}

function currentKeyOrNull(): Buffer | null {
  if (cachedCurrentKey) return cachedCurrentKey;
  const secret = config.contentEncryption.secret;
  if (!secret) return null;
  cachedCurrentKey = deriveKeyFromSecret(secret, CONTENT_HKDF_INFO);
  return cachedCurrentKey;
}

function previousKeyOrNull(): Buffer | null {
  if (cachedPreviousKey) return cachedPreviousKey;
  const secret = config.contentEncryption.secretPrevious;
  if (!secret) return null;
  cachedPreviousKey = deriveKeyFromSecret(secret, CONTENT_HKDF_INFO);
  return cachedPreviousKey;
}

function availableKeys(): Buffer[] {
  const keys: Buffer[] = [];
  const current = currentKeyOrNull();
  const previous = previousKeyOrNull();
  if (current) keys.push(current);
  if (previous && (!current || !previous.equals(current))) keys.push(previous);
  return keys;
}

function decryptsWith(
  envelope: string,
  key: Buffer | null,
  context: ContentEncryptionContext,
): boolean {
  if (!key) return false;
  try {
    decryptStringWithKey(envelope, key, context);
    return true;
  } catch {
    return false;
  }
}
