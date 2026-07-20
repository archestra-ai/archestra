import config from "@/config";
import EncryptionKeyCanaryModel from "@/models/encryption-key-canary";
import SecretModel from "@/models/secret";
import { describe, expect, test } from "@/test";
import { _resetCachedKey } from "@/utils/crypto";
import { verifySecretsEncryptionKey } from "./encryption-key-guard";

/**
 * Simulates an ARCHESTRA_AUTH_SECRET rotation: everything encrypted before
 * the call used the old key. Returns a restore function for `finally`.
 */
function rotateAuthSecret(): () => void {
  const original = config.auth.secret;
  _resetCachedKey();
  config.auth.secret = "rotated-auth-secret-that-cannot-decrypt-old-rows";
  return () => {
    config.auth.secret = original;
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

  test("aborts startup when the auth secret changes after the canary was written", async () => {
    await SecretModel.create({ name: "s1", secret: { apiKey: "sk-1" } });
    await verifySecretsEncryptionKey();

    const restore = rotateAuthSecret();
    try {
      await expect(verifySecretsEncryptionKey()).rejects.toThrow(
        "does not match the key previously used to encrypt stored secrets",
      );
    } finally {
      restore();
    }
  });

  test("aborts the first canary boot when existing secrets are already undecryptable (upgrade path)", async () => {
    await SecretModel.create({ name: "s1", secret: { apiKey: "sk-1" } });

    // The deployment rotated its auth secret BEFORE upgrading to a version
    // with the canary check — the current key must not be blessed.
    const restore = rotateAuthSecret();
    try {
      await expect(verifySecretsEncryptionKey()).rejects.toThrow(
        "ARCHESTRA_AUTH_SECRET",
      );
      expect(await EncryptionKeyCanaryModel.get()).toBeNull();
    } finally {
      restore();
    }
  });

  test("accepts a rotated key when ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY is set", async () => {
    await SecretModel.create({ name: "s1", secret: { apiKey: "sk-1" } });
    await verifySecretsEncryptionKey();

    const restore = rotateAuthSecret();
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
