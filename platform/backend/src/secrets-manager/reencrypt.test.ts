import { describe, expect, test } from "vitest";
import config from "@/config";
import EncryptionKeyCanaryModel from "@/models/encryption-key-canary";
import SecretModel from "@/models/secret";
import { _resetCachedKey } from "@/utils/crypto";
import { reencryptStoredSecrets } from "./reencrypt";

// The current (test) encryption secret; secrets are created under this key.
const OLD_SECRET = "auth-secret-unit-tests-32-chars!";
const NEW_SECRET = "brand-new-encryption-secret-value-here";

/** Run `fn` with the process encryption key switched to `secret`. */
async function withEncryptionSecret<T>(
  secret: string,
  fn: () => Promise<T>,
): Promise<T> {
  const original = config.secretsManager.encryptionSecret;
  config.secretsManager.encryptionSecret = secret;
  _resetCachedKey();
  try {
    return await fn();
  } finally {
    config.secretsManager.encryptionSecret = original;
    _resetCachedKey();
  }
}

describe("reencryptStoredSecrets", () => {
  test("re-encrypts DB secrets from the previous key to the new key", async () => {
    const s1 = await SecretModel.create({
      name: "s1",
      secret: { apiKey: "sk-old-1" },
    });
    const s2 = await SecretModel.create({
      name: "s2",
      secret: { apiKey: "sk-old-2" },
    });
    await EncryptionKeyCanaryModel.create("v1:dummy:canary:blob");

    // Migration environment: the process encryption key is now the NEW secret.
    await withEncryptionSecret(NEW_SECRET, async () => {
      const result = await reencryptStoredSecrets({
        previousSecret: OLD_SECRET,
        nextSecret: NEW_SECRET,
      });

      expect(result.status).toBe("completed");
      expect(result.reencrypted).toBe(2);
      expect(result.unreadable).toBe(0);

      // Reads decrypt with the CURRENT (new) key and return the plaintext.
      expect((await SecretModel.findById(s1.id))?.secret).toEqual({
        apiKey: "sk-old-1",
      });
      expect((await SecretModel.findById(s2.id))?.secret).toEqual({
        apiKey: "sk-old-2",
      });

      // reencrypt leaves the canary untouched — the startup guard refreshes it.
      expect((await EncryptionKeyCanaryModel.get())?.encryptedCanary).toBe(
        "v1:dummy:canary:blob",
      );
    });
  });

  test("is a no-op when the encryption secret is unchanged", async () => {
    await SecretModel.create({ name: "s", secret: { apiKey: "v" } });
    const result = await reencryptStoredSecrets({
      previousSecret: OLD_SECRET,
      nextSecret: OLD_SECRET,
    });
    expect(result.status).toBe("noop");
    expect(result.reencrypted).toBe(0);
  });

  test("is idempotent — a second run skips already-migrated rows", async () => {
    const s = await SecretModel.create({ name: "s", secret: { apiKey: "v" } });

    await withEncryptionSecret(NEW_SECRET, async () => {
      await reencryptStoredSecrets({
        previousSecret: OLD_SECRET,
        nextSecret: NEW_SECRET,
      });
      const second = await reencryptStoredSecrets({
        previousSecret: OLD_SECRET,
        nextSecret: NEW_SECRET,
      });

      expect(second.reencrypted).toBe(0);
      expect(second.alreadyNew).toBe(1);
      expect((await SecretModel.findById(s.id))?.secret).toEqual({
        apiKey: "v",
      });
    });
  });
});
