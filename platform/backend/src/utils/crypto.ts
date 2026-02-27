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
const INFO = "archestra-secret-encryption-v1";
const VERSION_PREFIX = "v1";

let cachedKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const authSecret = config.auth.secret;
  if (!authSecret) {
    throw new Error("ARCHESTRA_AUTH_SECRET is required for secret encryption");
  }

  cachedKey = Buffer.from(hkdfSync("sha256", authSecret, "", INFO, KEY_LENGTH));
  return cachedKey;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromBase64Url(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

export function encryptSecretValue(plaintext: Record<string, unknown>): {
  __encrypted: string;
} {
  const key = getEncryptionKey();
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

export function decryptSecretValue(encrypted: {
  __encrypted: string;
}): Record<string, unknown> {
  const parts = encrypted.__encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    throw new Error("Invalid encrypted secret format");
  }

  const [, ivStr, authTagStr, ciphertextStr] = parts;
  const key = getEncryptionKey();
  const iv = fromBase64Url(ivStr);
  const authTag = fromBase64Url(authTagStr);
  const ciphertext = fromBase64Url(ciphertextStr);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8"));
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
 * Reset the cached encryption key (for testing only).
 */
export function _resetCachedKey(): void {
  cachedKey = null;
}
