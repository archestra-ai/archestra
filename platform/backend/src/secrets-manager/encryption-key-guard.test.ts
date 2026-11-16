import { describe, expect, test } from "vitest";
import config from "@/config";
import EncryptionKeyCanaryModel from "@/models/encryption-key-canary";
import SecretModel from "@/models/secret";
import { _resetCachedKey } from "@/utils/crypto";
import { verifySecretsEncryptionKey } from "./encryption-key-guard";

// The encryption key derives from config.secretsManager.encryptionSecret; in
// tests it falls back to ARCHESTRA_AUTH_SECRET (see test/setup.ts).
const TEST_SECRET = "auth-secret-unit-tests-32-chars!";

/**
 * Point the encryption key at `next`, with `previous` as the prior secret the
 * startup re-encryption path may use. Returns a restore fn for `finally`.
 */
function withEncryptionKeys(next: string, previous: string): () => void {
  const originalNext = config.secretsManager.encryptionSecret;
  const originalPrev = config.secretsManager.encryptionSecretPrevious;
  _resetCachedKey();
  config.secretsManager.encryptionSecret = next;
  config.secretsManager.encryptionSecretPrevious = previous;
  return () => {
    config.secretsManager.encryptionSecret = originalNext;
    config.secretsManager.encryptionSecretPrevious = originalPrev;
    _resetCachedKey();
  };
}

describe("verifySecretsEncryptionKey", () => {
  test("writes a canary on first boot and passes on subsequent boots", async () => {
    await SecretModel.create({ name: "s1", secret: { apiKey: "sk-1" } });

    await verifySecretsEncryptionKey();
    expect(await EncryptionKeyCanaryModel.get()).not.toBeNull();

    // Second boot with the same key verifies against the canary.
    await verifySecretsEncryptionKey();
  });

  test("re-encrypts stored secrets when the encryption secret is rotated with a valid previous key", async () => {
    const s1 = await SecretModel.create({
      name: "s1",
      secret: { apiKey: "sk-1" },
    });
    await verifySecretsEncryptionKey(); // canary written under TEST_SECRET

    // Rotate to a NEW encryption secret; the previous is the old (valid) one.
    const restore = withEncryptionKeys(
      "brand-new-encryption-secret-value",
      TEST_SECRET,
    );
    try {
      // Migrates instead of throwing; the secret decrypts under the new key.
      await verifySecretsEncryptionKey();
      expect((await SecretModel.findById(s1.id))?.secret).toEqual({
        apiKey: "sk-1",
      });
    } finally {
      restore();
    }

    // The canary was refreshed under the new key: a later boot with only that
    // key (no previous) passes without re-encrypting again.
    const restore2 = withEncryptionKeys(
      "brand-new-encryption-secret-value",
      "brand-new-encryption-secret-value",
    );
    try {
      await verifySecretsEncryptionKey();
    } finally {
      restore2();
    }
  });

  test("aborts when the encryption secret changes and no previous key can decrypt", async () => {
    await SecretModel.create({ name: "s1", secret: { apiKey: "sk-1" } });
    await verifySecretsEncryptionKey();

    // Neither the current nor the previous key can decrypt the existing rows.
    const restore = withEncryptionKeys(
      "new-unrecoverable-secret",
      "also-wrong-previous-secret",
    );
    try {
      await expect(verifySecretsEncryptionKey()).rejects.toThrow(
        "does not match the key previously used to encrypt stored secrets",
      );
    } finally {
      restore();
    }
  });

  test("aborts the first canary boot when existing secrets are already undecryptable", async () => {
    await SecretModel.create({ name: "s1", secret: { apiKey: "sk-1" } });

    // No canary yet, and the current key can't decrypt the existing rows.
    const restore = withEncryptionKeys(
      "new-unrecoverable-secret",
      "also-wrong-previous-secret",
    );
    try {
      await expect(verifySecretsEncryptionKey()).rejects.toThrow(
        "ARCHESTRA_SECRETS_ENCRYPTION_SECRET",
      );
      expect(await EncryptionKeyCanaryModel.get()).toBeNull();
    } finally {
      restore();
    }
  });

  test("a secondary site only verifies: it never writes the canary or re-keys", async () => {
    await SecretModel.create({ name: "s1", secret: { apiKey: "sk-1" } });
    config.site.role = "secondary";
    try {
      await expect(verifySecretsEncryptionKey()).rejects.toThrow(
        "Start the primary site first",
      );
      expect(await EncryptionKeyCanaryModel.get()).toBeNull();

      config.site.role = "primary";
      await verifySecretsEncryptionKey();
      const canary = await EncryptionKeyCanaryModel.get();
      config.site.role = "secondary";
      await verifySecretsEncryptionKey();

      // Another secret, even with the escape hatch and a valid previous key.
      const restore = withEncryptionKeys("another-site-secret", TEST_SECRET);
      config.secretsManager.acceptNewEncryptionKey = true;
      try {
        await expect(verifySecretsEncryptionKey()).rejects.toThrow(
          "must use the primary site's auth Secret",
        );
      } finally {
        config.secretsManager.acceptNewEncryptionKey = false;
        restore();
      }
      expect(await EncryptionKeyCanaryModel.get()).toEqual(canary);
    } finally {
      config.site.role = "primary";
    }
  });

  test("accepts a rotated key when ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY is set", async () => {
    await SecretModel.create({ name: "s1", secret: { apiKey: "sk-1" } });
    await verifySecretsEncryptionKey();

    const restore = withEncryptionKeys(
      "new-unrecoverable-secret",
      "also-wrong-previous-secret",
    );
    try {
      config.secretsManager.acceptNewEncryptionKey = true;
      await verifySecretsEncryptionKey();

      // The canary was rewritten under the new key: later boots pass without
      // the escape hatch.
      config.secretsManager.acceptNewEncryptionKey = false;
      await verifySecretsEncryptionKey();
    } finally {
      config.secretsManager.acceptNewEncryptionKey = false;
      restore();
    }
  });
});
