// biome-ignore-all lint/suspicious/noConsole: standalone script uses console for logging
/**
 * Secret Encryption Key Rotation Script
 *
 * Re-encrypts all secrets in the database when rotating ARCHESTRA_AUTH_SECRET.
 *
 * Usage:
 *   OLD_ARCHESTRA_AUTH_SECRET=<old-secret> \
 *   ARCHESTRA_AUTH_SECRET=<new-secret> \
 *   ARCHESTRA_DATABASE_URL=postgresql://user:pass@host:5432/db \
 *   npx tsx src/standalone-scripts/rotate-secret-encryption-key.ts
 *
 * IMPORTANT: Stop the application before running this script to avoid race
 * conditions with concurrent secret writes.
 *
 * The script will:
 *   1. Derive encryption keys from both the old and new secrets
 *   2. Read all rows from the secret table
 *   3. Decrypt each with the old key and re-encrypt with the new key
 *   4. Update all rows in a single transaction (all-or-nothing)
 *
 * If DRY_RUN=true is set, the script will report what would change without writing.
 */
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import db, { initializeDatabase, schema } from "@/database";
import {
  decryptSecretValueWithKey,
  deriveKeyFromSecret,
  encryptSecretValueWithKey,
  isEncryptedSecret,
} from "@/utils/crypto";

export async function rotateSecretEncryptionKey(opts: {
  oldSecret: string;
  newSecret: string;
  dryRun?: boolean;
}): Promise<{ total: number; rotated: number; skippedPlaintext: number }> {
  const { oldSecret, newSecret, dryRun = false } = opts;

  if (oldSecret === newSecret) {
    throw new Error("Old and new secrets are identical — nothing to rotate.");
  }

  const oldKey = deriveKeyFromSecret(oldSecret);
  const newKey = deriveKeyFromSecret(newSecret);

  const rows = await db.select().from(schema.secretsTable);
  let rotated = 0;
  let skippedPlaintext = 0;

  if (dryRun) {
    for (const row of rows) {
      if (isEncryptedSecret(row.secret)) {
        // Verify we can decrypt with the old key
        decryptSecretValueWithKey(row.secret, oldKey);
      } else {
        skippedPlaintext++;
      }
      rotated++;
    }

    console.log(`[DRY RUN] Would rotate ${rotated} of ${rows.length} secrets`);
    if (skippedPlaintext > 0) {
      console.log(
        `[DRY RUN] ${skippedPlaintext} plaintext secrets would be encrypted with the new key`,
      );
    }
    return { total: rows.length, rotated, skippedPlaintext };
  }

  await db.transaction(async (tx) => {
    for (const row of rows) {
      let plaintext: Record<string, unknown>;

      if (isEncryptedSecret(row.secret)) {
        plaintext = decryptSecretValueWithKey(row.secret, oldKey);
      } else {
        // Plaintext row — encrypt it with the new key
        plaintext = row.secret;
        skippedPlaintext++;
      }

      const reEncrypted = encryptSecretValueWithKey(plaintext, newKey);

      await tx
        .update(schema.secretsTable)
        .set({ secret: reEncrypted })
        .where(eq(schema.secretsTable.id, row.id));
      rotated++;
    }
  });

  console.log(`Rotated ${rotated} of ${rows.length} secrets`);
  if (skippedPlaintext > 0) {
    console.log(
      `${skippedPlaintext} were plaintext and have been encrypted with the new key`,
    );
  }

  return { total: rows.length, rotated, skippedPlaintext };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const oldSecret = process.env.OLD_ARCHESTRA_AUTH_SECRET;
  const newSecret = process.env.ARCHESTRA_AUTH_SECRET;
  const dryRun = process.env.DRY_RUN === "true";

  if (!oldSecret) {
    console.error(
      "OLD_ARCHESTRA_AUTH_SECRET environment variable is required.",
    );
    process.exit(1);
  }
  if (!newSecret) {
    console.error("ARCHESTRA_AUTH_SECRET environment variable is required.");
    process.exit(1);
  }

  initializeDatabase()
    .then(() => rotateSecretEncryptionKey({ oldSecret, newSecret, dryRun }))
    .then(() => {
      console.log("Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Key rotation failed:", error.message);
      process.exit(1);
    });
}
