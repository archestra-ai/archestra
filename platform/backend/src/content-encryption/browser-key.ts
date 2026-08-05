import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared primitives for browser-held keys: features where a 32-byte key
 * lives only in the user's browser and rides requests as a header. Used by
 * incognito chats (free) and, together with the enterprise escrow helpers in
 * browser-key.ee.ts, by browser-key MCP credentials — each feature brings
 * its own header, fingerprint domain, and AAD scheme.
 */

const BROWSER_KEY_LENGTH_BYTES = 32;

/**
 * Parse a browser-key header value. Returns null when absent; throws when
 * present but malformed (not base64url, wrong length) so routes can 400
 * with a precise message instead of failing GCM later.
 */
export function parseBrowserKeyHeader(
  headerValue: string | undefined,
): Buffer | null {
  if (headerValue === undefined || headerValue === "") return null;
  let key: Buffer;
  try {
    key = Buffer.from(headerValue, "base64url");
  } catch {
    throw new Error("browser key header is not valid base64url");
  }
  if (key.length !== BROWSER_KEY_LENGTH_BYTES) {
    throw new Error(
      `browser key must decode to exactly ${BROWSER_KEY_LENGTH_BYTES} bytes`,
    );
  }
  return key;
}

/**
 * Domain-separated fingerprint of a browser key bound to a subject id
 * (conversation, MCP server). Stored on the row so a wrong key is rejected
 * up front with a clean error instead of scattered GCM failures.
 */
export function browserKeyFingerprint(params: {
  domain: string;
  subjectId: string;
  key: Buffer;
}): string {
  return createHash("sha256")
    .update(params.domain)
    .update(params.subjectId)
    .update(params.key)
    .digest("hex");
}

/** Constant-time comparison of a stored fingerprint against a presented key. */
export function browserKeyMatches(params: {
  storedFingerprint: string;
  domain: string;
  subjectId: string;
  key: Buffer;
}): boolean {
  const presented = Buffer.from(
    browserKeyFingerprint({
      domain: params.domain,
      subjectId: params.subjectId,
      key: params.key,
    }),
    "hex",
  );
  const stored = Buffer.from(params.storedFingerprint, "hex");
  return (
    stored.length === presented.length && timingSafeEqual(stored, presented)
  );
}
