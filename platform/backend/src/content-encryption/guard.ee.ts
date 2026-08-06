// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import config from "@/config";
import logger from "@/logging";
import EncryptionKeyCanaryModel from "@/models/encryption-key-canary";
import {
  decryptStringWithKey,
  deriveKeyFromSecret,
  encryptStringWithKey,
} from "@/utils/crypto";
import {
  isContentDecryptionAvailable,
  isContentEncryptionEnabled,
} from "./index.ee";

/**
 * Boot-time gate for enterprise content encryption. Runs on BOTH boot paths
 * (web and worker — workers write messages and interactions too), before any
 * write that could encrypt.
 *
 * Deliberately fail-closed and stricter than the secrets-key guard: stored
 * secrets can be re-entered after a key loss, chat history and interaction
 * logs cannot. There is therefore NO accept-new-key escape hatch here.
 *
 * Decision tree:
 * - key configured without an enterprise license → fail startup (an operator
 *   who configured encryption must never silently run unencrypted).
 * - no canary, feature off → nothing to do.
 * - no canary, feature on → first enablement: mint the canary.
 * - canary present, no key at all → fail startup (encryption was enabled on
 *   this database; without the key, existing rows are unreadable and new
 *   writes would silently go out in plaintext).
 * - canary present, current key opens it → verified.
 * - canary present, only the previous key opens it → rotation in progress:
 *   re-mint the canary under the current key (the backfill sweep re-encrypts
 *   the data rows).
 * - canary present, no configured key opens it → fail startup.
 */
export async function verifyContentEncryptionKey(): Promise<void> {
  const { secret, secretPrevious } = config.contentEncryption;

  if ((secret || secretPrevious) && !config.enterpriseFeatures.core) {
    throw new Error(
      "Content encryption at rest (ARCHESTRA_CONTENT_ENCRYPTION_SECRET) " +
        "requires an enterprise license. Unset the variable or contact " +
        "sales@archestra.ai.",
    );
  }

  // Encryption flips the content-capture DEFAULT off (config.ts); reaching
  // here with capture on means the operator explicitly opted back in. Keep
  // that visible: plaintext prompts/completions/tool payloads are leaving for
  // the telemetry backend while the database copies are encrypted.
  if (secret && config.observability.otel.captureContent) {
    logger.warn(
      "ARCHESTRA_OTEL_CAPTURE_CONTENT=true overrides the encryption-at-rest " +
        "default: message and tool content is exported in plaintext on OTel " +
        "spans. Ensure the telemetry backend is protected accordingly.",
    );
  }

  const canary = await EncryptionKeyCanaryModel.get("content");

  if (!canary) {
    if (!isContentEncryptionEnabled()) return;
    await EncryptionKeyCanaryModel.create(
      newContentCanaryBlob(mustDerive(secret)),
      "content",
    );
    logger.info(
      "content encryption enabled — canary minted for the current key",
    );
    return;
  }

  if (!isContentDecryptionAvailable()) {
    throw new Error(
      "Content encryption was previously enabled on this database (content " +
        "key canary present) but no ARCHESTRA_CONTENT_ENCRYPTION_SECRET or " +
        "ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS is configured. " +
        "Existing encrypted content would be unreadable and new writes would " +
        "silently be stored in plaintext. Restore the key to start.",
    );
  }

  if (secret && canaryOpensWith(canary.encryptedCanary, secret)) {
    return;
  }

  if (
    secretPrevious &&
    canaryOpensWith(canary.encryptedCanary, secretPrevious)
  ) {
    // Rotation in progress (or the decrypt-only pre-distribution rollout).
    // Deliberately do NOT re-mint here: during a rolling swap, replicas with
    // the old and new variable assignments would each see the other's canary
    // as "previous" and ping-pong it, resetting the backfill's fingerprint
    // state each time. The cluster-singleton backfill re-mints the canary
    // exactly once, when the re-encryption sweep completes.
    if (secret) {
      logger.info(
        "content encryption key rotation detected — existing rows will be " +
          "re-encrypted by the backfill sweep",
      );
    }
    return;
  }

  throw new Error(
    "The configured content encryption key(s) cannot decrypt the content " +
      "key canary: neither ARCHESTRA_CONTENT_ENCRYPTION_SECRET nor " +
      "ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS matches the key this " +
      "database's content was encrypted with. Restore the correct key — " +
      "there is deliberately no override, because encrypted chat history " +
      "and logs cannot be re-entered.",
  );
}

/**
 * Re-mint the content canary under the CURRENT key. Called by the backfill
 * sweep on completion — the single, cluster-singleton actor — so a rolling
 * rotation can never ping-pong the canary between replica configurations.
 */
export async function remintContentCanaryForCurrentKey(): Promise<void> {
  const { secret } = config.contentEncryption;
  if (!secret) return;
  const canary = await EncryptionKeyCanaryModel.get("content");
  const blob = newContentCanaryBlob(mustDerive(secret));
  if (canary) {
    if (canaryOpensWith(canary.encryptedCanary, secret)) return;
    await EncryptionKeyCanaryModel.replace(canary.id, blob);
  } else {
    await EncryptionKeyCanaryModel.create(blob, "content");
  }
}

// === Internal ===

const CANARY_AAD = "encryption_key_canaries.content";
const CANARY_PAYLOAD = "archestra-content-encryption-canary-v1";
const CONTENT_HKDF_INFO = "archestra-content-encryption-v1";

function mustDerive(secret: string | undefined): Buffer {
  if (!secret) {
    throw new Error("content encryption secret unexpectedly missing");
  }
  return deriveKeyFromSecret(secret, CONTENT_HKDF_INFO);
}

function newContentCanaryBlob(key: Buffer): string {
  return encryptStringWithKey(CANARY_PAYLOAD, key, CANARY_AAD);
}

function canaryOpensWith(encryptedCanary: string, secret: string): boolean {
  try {
    return (
      decryptStringWithKey(encryptedCanary, mustDerive(secret), CANARY_AAD) ===
      CANARY_PAYLOAD
    );
  } catch {
    return false;
  }
}
