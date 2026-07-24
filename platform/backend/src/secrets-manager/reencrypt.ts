import { sql } from "drizzle-orm";
import db from "@/database";
import logger from "@/logging";
import SecretModel from "@/models/secret";
import {
  decryptSecretValueWithKey,
  deriveKeyFromSecret,
  encryptSecretValueWithKey,
  isEncryptedSecret,
} from "@/utils/crypto";

// Fixed advisory-lock key so concurrent runners (e.g. two migration Jobs)
// serialize instead of racing the re-encryption.
const ADVISORY_LOCK_KEY = 4927001;

type ReencryptResult = {
  /** "noop" when the previous and next keys are identical. */
  status: "noop" | "completed";
  reencrypted: number;
  alreadyNew: number;
  notEncrypted: number;
  unreadable: number;
  total: number;
};

/**
 * Re-encrypt every DB-stored secret from the key derived from `previousSecret`
 * to the key derived from `nextSecret`. Idempotent: rows already under the new
 * key are skipped, so a retry (or a run where nothing changed) is safe. Rows
 * that decrypt with neither key are left untouched and counted as unreadable.
 *
 * On completion the encryption-key canary is dropped so the startup guard
 * re-mints it under the new key after validating the now-migrated secrets.
 */
export async function reencryptStoredSecrets(params: {
  previousSecret: string;
  nextSecret: string;
}): Promise<ReencryptResult> {
  const newKey = deriveKeyFromSecret(params.nextSecret);
  const oldKey = deriveKeyFromSecret(params.previousSecret);

  if (newKey.equals(oldKey)) {
    return {
      status: "noop",
      reencrypted: 0,
      alreadyNew: 0,
      notEncrypted: 0,
      unreadable: 0,
      total: 0,
    };
  }

  await db.execute(sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
  try {
    const rows = await SecretModel.findAllRaw();
    let reencrypted = 0;
    let alreadyNew = 0;
    let notEncrypted = 0;
    let unreadable = 0;

    for (const row of rows) {
      if (!isEncryptedSecret(row.secret)) {
        // Vault-managed rows / empty placeholders carry no ciphertext.
        notEncrypted++;
        continue;
      }
      if (tryDecrypt(row.secret, newKey)) {
        // Already migrated (retry / partially-completed run).
        alreadyNew++;
        continue;
      }
      const plaintext = tryDecrypt(row.secret, oldKey);
      if (!plaintext) {
        unreadable++;
        logger.warn(
          { secretId: row.id },
          "[reencrypt] secret not decryptable with the previous key; left unchanged",
        );
        continue;
      }
      await SecretModel.updateRawSecret(
        row.id,
        encryptSecretValueWithKey(plaintext, newKey),
      );
      reencrypted++;
    }

    // The encryption-key canary is intentionally left to the caller (the
    // startup guard) to refresh under the new key — keeping this function
    // purely about the `secret` table.

    return {
      status: "completed",
      reencrypted,
      alreadyNew,
      notEncrypted,
      unreadable,
      total: rows.length,
    };
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
  }
}

function tryDecrypt(
  encrypted: { __encrypted: string },
  key: Buffer,
): Record<string, unknown> | null {
  try {
    return decryptSecretValueWithKey(encrypted, key);
  } catch {
    return null;
  }
}
