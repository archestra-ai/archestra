import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db, { schema } from "@/database";
import {
  decryptSecretValueWithKey,
  deriveKeyFromSecret,
  encryptSecretValueWithKey,
  isEncryptedSecret,
} from "@/utils/crypto";
import { rotateSecretEncryptionKey } from "./rotate-secret-encryption-key";

const OLD_SECRET = "old-test-secret-that-is-at-least-32-chars";
const NEW_SECRET = "new-test-secret-that-is-at-least-32-chars";

async function insertEncryptedSecret(
  name: string,
  plaintext: Record<string, unknown>,
  secret: string,
) {
  const key = deriveKeyFromSecret(secret);
  const [row] = await db
    .insert(schema.secretsTable)
    .values({ name, secret: encryptSecretValueWithKey(plaintext, key) })
    .returning();
  return row;
}

async function insertPlaintextSecret(
  name: string,
  plaintext: Record<string, unknown>,
) {
  const [row] = await db
    .insert(schema.secretsTable)
    .values({ name, secret: plaintext })
    .returning();
  return row;
}

async function readRawSecret(id: string) {
  const [row] = await db
    .select()
    .from(schema.secretsTable)
    .where(eq(schema.secretsTable.id, id));
  return row;
}

describe("rotateSecretEncryptionKey", () => {
  it("re-encrypts secrets from old key to new key", async () => {
    const original = { apiKey: "sk-test-rotate-123" };
    const row = await insertEncryptedSecret(
      "rotate-test",
      original,
      OLD_SECRET,
    );

    await rotateSecretEncryptionKey({
      oldSecret: OLD_SECRET,
      newSecret: NEW_SECRET,
    });

    // Verify the DB value is encrypted with the new key
    const updated = await readRawSecret(row.id);
    expect(isEncryptedSecret(updated.secret)).toBe(true);

    const newKey = deriveKeyFromSecret(NEW_SECRET);
    const decrypted = decryptSecretValueWithKey(
      updated.secret as { __encrypted: string },
      newKey,
    );
    expect(decrypted).toEqual(original);

    // Verify old key can no longer decrypt
    const oldKey = deriveKeyFromSecret(OLD_SECRET);
    expect(() =>
      decryptSecretValueWithKey(
        updated.secret as { __encrypted: string },
        oldKey,
      ),
    ).toThrow();
  });

  it("encrypts plaintext secrets with the new key", async () => {
    const original = { token: "plain-token-value" };
    const row = await insertPlaintextSecret("plaintext-test", original);

    const result = await rotateSecretEncryptionKey({
      oldSecret: OLD_SECRET,
      newSecret: NEW_SECRET,
    });

    expect(result.newlyEncrypted).toBeGreaterThanOrEqual(1);

    const updated = await readRawSecret(row.id);
    expect(isEncryptedSecret(updated.secret)).toBe(true);

    const newKey = deriveKeyFromSecret(NEW_SECRET);
    const decrypted = decryptSecretValueWithKey(
      updated.secret as { __encrypted: string },
      newKey,
    );
    expect(decrypted).toEqual(original);
  });

  it("throws when old and new secrets are identical", async () => {
    await expect(
      rotateSecretEncryptionKey({
        oldSecret: OLD_SECRET,
        newSecret: OLD_SECRET,
      }),
    ).rejects.toThrow("identical");
  });

  it("dry run does not modify secrets", async () => {
    const original = { apiKey: "sk-dry-run" };
    const row = await insertEncryptedSecret(
      "dry-run-test",
      original,
      OLD_SECRET,
    );
    const before = await readRawSecret(row.id);

    const result = await rotateSecretEncryptionKey({
      oldSecret: OLD_SECRET,
      newSecret: NEW_SECRET,
      dryRun: true,
    });

    expect(result.reEncrypted).toBeGreaterThanOrEqual(1);

    const after = await readRawSecret(row.id);
    expect(after.secret).toEqual(before.secret);
  });
});
