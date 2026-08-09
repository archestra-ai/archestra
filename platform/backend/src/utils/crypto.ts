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

/**
 * Exact envelope shape: `v1:<iv>:<authTag>:<ciphertext>`, all base64url.
 * Detection is strict so arbitrary user JSON that merely contains an
 * `__encrypted` key can never be misread as ciphertext.
 */
const ENVELOPE_PATTERN = /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

let cachedKey: Buffer | null = null;

/**
 * Derive an AES-256 key from a raw secret via HKDF. `info` provides domain
 * separation — independent features derive unrelated keys from unrelated
 * secrets AND unrelated info strings, so a leaked key for one domain says
 * nothing about another. Defaults to the stored-secrets domain. Exposed so
 * the re-encryption migration can hold the previous and current keys at once.
 * @public — used by standalone-scripts/reencrypt-secrets.ts and content-encryption
 */
export function deriveKeyFromSecret(
  secret: string,
  info: string = INFO,
): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, SALT, info, KEY_LENGTH));
}

/**
 * Encrypt an arbitrary UTF-8 string into a `v1:` envelope string under an
 * explicit key. `aad` (additional authenticated data) binds the ciphertext to
 * a context such as `"<table>.<column>"` — decryption with a different AAD
 * fails authentication, so a valid envelope cannot be transplanted between
 * contexts by a database-level writer.
 * @public — used by content-encryption
 */
export function encryptStringWithKey(
  plaintext: string,
  key: Buffer,
  aad?: string,
): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  if (aad) {
    cipher.setAAD(Buffer.from(aad, "utf8"));
  }

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${VERSION_PREFIX}:${toBase64Url(iv)}:${toBase64Url(authTag)}:${toBase64Url(encrypted)}`;
}

/**
 * Decrypt a `v1:` envelope string under an explicit key. Throws on format or
 * authentication failure (wrong key OR wrong AAD).
 * @public — used by content-encryption
 */
export function decryptStringWithKey(
  envelope: string,
  key: Buffer,
  aad?: string,
): string {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    throw new Error("Invalid encrypted value format");
  }

  const [, ivStr, authTagStr, ciphertextStr] = parts;
  const iv = fromBase64Url(ivStr);
  const authTag = fromBase64Url(authTagStr);
  const ciphertext = fromBase64Url(ciphertextStr);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  if (aad) {
    decipher.setAAD(Buffer.from(aad, "utf8"));
  }
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Strict envelope-string check — see {@link ENVELOPE_PATTERN}.
 * @public — used by content-encryption
 */
export function isEncryptedEnvelope(value: unknown): value is string {
  return typeof value === "string" && ENVELOPE_PATTERN.test(value);
}

/**
 * Strict envelope-object check: exactly `{ __encrypted: "<v1 envelope>" }`
 * and nothing else, so arbitrary user JSON that merely contains an
 * `__encrypted` key can never be misread as ciphertext. Shared by the
 * incognito-chat layer and the enterprise at-rest layer (which re-exports it).
 */
export function isContentEnvelope(
  value: unknown,
): value is { __encrypted: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    isEncryptedEnvelope((value as Record<string, unknown>).__encrypted)
  );
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
  return { __encrypted: encryptStringWithKey(JSON.stringify(plaintext), key) };
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
  let decrypted: string;
  try {
    decrypted = decryptStringWithKey(encrypted.__encrypted, key);
  } catch (error) {
    if (error instanceof Error && error.message.includes("format")) {
      throw new Error("Invalid encrypted secret format");
    }
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

  return JSON.parse(decrypted);
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

// === Internal ===

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
