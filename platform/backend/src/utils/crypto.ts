import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import config from "@/config";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT = "archestra-hkdf-salt-v1";
const INFO = "archestra-secret-encryption-v1";
const VERSION_PREFIX = "v1";

let cachedKey: Buffer | null = null;

/**
 * Derive the AES-256 key from a raw secret via HKDF. Exposed so the
 * re-encryption migration can hold the previous and current keys at once.
 * @public — used by standalone-scripts/reencrypt-secrets.ts
 */
export function deriveKeyFromSecret(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, SALT, INFO, KEY_LENGTH));
}

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const encryptionSecret = config.secretsManager.encryptionSecret;
  if (!encryptionSecret) {
    throw new Error(
      "ARCHESTRA_SECRETS_ENCRYPTION_SECRET (or legacy ARCHESTRA_AUTH_SECRET) is required for secret encryption",
    );
  }

  cachedKey = deriveKeyFromSecret(encryptionSecret);
  return cachedKey;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromBase64Url(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

/**
 * Encrypt a value under an explicit key. Exposed for the re-encryption
 * migration; normal call sites use {@link encryptSecretValue}.
 * @public — used by standalone-scripts/reencrypt-secrets.ts
 */
export function encryptSecretValueWithKey(
  plaintext: Record<string, unknown>,
  key: Buffer,
): { __encrypted: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const json = JSON.stringify(plaintext);
  const encrypted = Buffer.concat([
    cipher.update(json, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    __encrypted: `${VERSION_PREFIX}:${toBase64Url(iv)}:${toBase64Url(authTag)}:${toBase64Url(encrypted)}`,
  };
}

/**
 * Decrypt a value under an explicit key. Exposed for the re-encryption
 * migration; normal call sites use {@link decryptSecretValue}.
 * @public — used by standalone-scripts/reencrypt-secrets.ts
 */
export function decryptSecretValueWithKey(
  encrypted: { __encrypted: string },
  key: Buffer,
): Record<string, unknown> {
  const parts = encrypted.__encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    throw new Error("Invalid encrypted secret format");
  }

  const [, ivStr, authTagStr, ciphertextStr] = parts;
  const iv = fromBase64Url(ivStr);
  const authTag = fromBase64Url(authTagStr);
  const ciphertext = fromBase64Url(ciphertextStr);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    // Node throws an opaque "Unsupported state or unable to authenticate
    // data" here; name the overwhelmingly likely operational cause instead.
    throw new Error(
      "Failed to decrypt stored secret: it was encrypted with a different key " +
        "than the one derived from the current ARCHESTRA_SECRETS_ENCRYPTION_SECRET " +
        "(the encryption secret was rotated without running the re-encryption " +
        "migration, or the database came from an environment with a different secret)",
      { cause: error },
    );
  }

  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * Encrypt using the cached key derived from ARCHESTRA_AUTH_SECRET.
 */
export function encryptSecretValue(plaintext: Record<string, unknown>): {
  __encrypted: string;
} {
  return encryptSecretValueWithKey(plaintext, getEncryptionKey());
}

/**
 * Decrypt using the cached key derived from ARCHESTRA_AUTH_SECRET.
 */
export function decryptSecretValue(encrypted: {
  __encrypted: string;
}): Record<string, unknown> {
  return decryptSecretValueWithKey(encrypted, getEncryptionKey());
}

export function isEncryptedSecret(
  value: unknown,
): value is { __encrypted: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "__encrypted" in value &&
    typeof (value as Record<string, unknown>).__encrypted === "string" &&
    (value as { __encrypted: string }).__encrypted.startsWith(
      `${VERSION_PREFIX}:`,
    )
  );
}

/**
 * Eagerly validate that the encryption key can be derived.
 * Call at startup to fail fast if ARCHESTRA_AUTH_SECRET is missing.
 */
export function ensureEncryptionKeyAvailable(): void {
  getEncryptionKey();
}

/**
 * Reset the cached encryption key.
 * @public — exported for testability
 */
export function _resetCachedKey(): void {
  cachedKey = null;
}
