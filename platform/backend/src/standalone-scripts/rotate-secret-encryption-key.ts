// biome-ignore-all lint/suspicious/noConsole: standalone script uses console for logging
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import db, { initializeDatabase, schema } from "@/database";
import {
  decryptSecretValueWithKey,
  deriveKeyFromSecret,
  encryptSecretValueWithKey,
  isEncryptedSecret,
} from "@/utils/crypto";

const HELP_TEXT = `
Secret Encryption Key Rotation Script

Re-encrypts all secrets in the database when rotating ARCHESTRA_AUTH_SECRET.

IMPORTANT: Stop the application before running this script to avoid race
conditions with concurrent secret writes.

Usage:
  OLD_ARCHESTRA_AUTH_SECRET=<old-secret> \\
  ARCHESTRA_AUTH_SECRET=<new-secret> \\
  ARCHESTRA_DATABASE_URL=postgresql://user:pass@host:5432/db \\
  npx tsx src/standalone-scripts/rotate-secret-encryption-key.ts

Environment variables:
  OLD_ARCHESTRA_AUTH_SECRET   The previous secret (required)
  ARCHESTRA_AUTH_SECRET       The new secret (required)
  ARCHESTRA_DATABASE_URL      PostgreSQL connection string (required)
  DRY_RUN=true                Preview what would change without writing

The script will:
  1. Derive encryption keys from both the old and new secrets
  2. Read all rows from the secret table
  3. Decrypt each with the old key and re-encrypt with the new key
  4. Update all rows in a single transaction (all-or-nothing)
`.trim();

export async function rotateSecretEncryptionKey(opts: {
  oldSecret: string;
  newSecret: string;
  dryRun?: boolean;
}): Promise<{
  total: number;
  reEncrypted: number;
  newlyEncrypted: number;
}> {
  const { oldSecret, newSecret, dryRun = false } = opts;

  if (oldSecret === newSecret) {
    throw new Error("Old and new secrets are identical — nothing to rotate.");
  }

  const oldKey = deriveKeyFromSecret(oldSecret);
  const newKey = deriveKeyFromSecret(newSecret);

  const rows = await db.select().from(schema.secretsTable);
  let reEncrypted = 0;
  let newlyEncrypted = 0;

  if (dryRun) {
    for (const row of rows) {
      if (isEncryptedSecret(row.secret)) {
        // Verify we can decrypt with the old key
        decryptSecretValueWithKey(row.secret, oldKey);
        reEncrypted++;
      } else {
        newlyEncrypted++;
      }
    }

    console.log(
      `[DRY RUN] Would re-encrypt ${reEncrypted} secrets, newly encrypt ${newlyEncrypted} plaintext secrets (${rows.length} total)`,
    );
    return { total: rows.length, reEncrypted, newlyEncrypted };
  }

  await db.transaction(async (tx) => {
    for (const row of rows) {
      let plaintext: Record<string, unknown>;

      if (isEncryptedSecret(row.secret)) {
        plaintext = decryptSecretValueWithKey(row.secret, oldKey);
        reEncrypted++;
      } else {
        plaintext = row.secret;
        newlyEncrypted++;
      }

      const encrypted = encryptSecretValueWithKey(plaintext, newKey);

      await tx
        .update(schema.secretsTable)
        .set({ secret: encrypted })
        .where(eq(schema.secretsTable.id, row.id));
    }
  });

  console.log(
    `Re-encrypted ${reEncrypted} secrets, newly encrypted ${newlyEncrypted} plaintext secrets (${rows.length} total)`,
  );

  return { total: rows.length, reEncrypted, newlyEncrypted };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

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
