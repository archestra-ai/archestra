/**
 * OpenAPPA stores a receipt or consult value in its plaintext escape envelope
 * when PostgreSQL cannot store it as it is: a value holding a NUL character,
 * or one that looks like an envelope itself. A host reading those columns
 * directly reads the value through the envelope, so nobody is shown the
 * envelope text. An encrypted envelope needs the conversation key and stays
 * as stored, as it always has.
 */

/** The JSON value a `jsonb` column holds, read through a plaintext envelope. */
export function openPlainJson<T>(value: T): T | unknown {
  if (!isJsonEnvelope(value)) return value;
  const body = plainBody(value[JSON_KEY]);
  if (body === null) return value;
  try {
    return JSON.parse(body);
  } catch {
    return value;
  }
}

/**
 * `value` as a `jsonb` column can hold it: as it is, unless it holds a NUL
 * character or looks like an envelope, which go in the plaintext envelope
 * that {@link openPlainJson} reads, as OpenAPPA writes them.
 */
export function sealPlainJson<T>(value: T): T | { [JSON_KEY]: string } {
  if (!isJsonEnvelope(value) && !holdsNul(value)) return value;
  const bytes = Buffer.concat([
    MAGIC,
    Buffer.from([PLAINTEXT]),
    Buffer.from(JSON.stringify(value), "utf8"),
  ]);
  return { [JSON_KEY]: bytes.toString("base64") };
}

/** The text a `text` column holds, read through a plaintext envelope. */
export function openPlainText(text: string): string;
export function openPlainText(text: string | null): string | null;
export function openPlainText(text: string | null): string | null {
  if (text === null || !text.startsWith(TEXT_PREFIX)) return text;
  return plainBody(text.slice(TEXT_PREFIX.length)) ?? text;
}

// ===

const JSON_KEY = "__appa_encrypted";
const TEXT_PREFIX = "appa-storage-v1:";
/** The bytes every envelope starts with, before its mode byte. */
const MAGIC = Buffer.from("\0appa-storage-v1\0", "latin1");
/** The mode byte of a plaintext escape; 1 marks ciphertext. */
const PLAINTEXT = 0;

function isJsonEnvelope(value: unknown): value is { [JSON_KEY]: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)[JSON_KEY] === "string"
  );
}

/** Whether a string or object key anywhere in `value` holds a NUL character. */
function holdsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(holdsNul);
  if (typeof value === "object" && value !== null)
    return Object.entries(value).some(
      ([key, field]) => key.includes("\u0000") || holdsNul(field),
    );
  return false;
}

/** The UTF-8 text a plaintext envelope's base64 holds, or null for any other. */
function plainBody(encoded: string): string | null {
  if (!BASE64.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length <= MAGIC.length ||
    !bytes.subarray(0, MAGIC.length).equals(MAGIC) ||
    bytes[MAGIC.length] !== PLAINTEXT
  )
    return null;
  try {
    return UTF8.decode(bytes.subarray(MAGIC.length + 1));
  } catch {
    return null;
  }
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
