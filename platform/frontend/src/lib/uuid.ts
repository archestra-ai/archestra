/**
 * Generates a random UUIDv4 string.
 *
 * `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost), so
 * deployments reached over plain HTTP (e.g. `http://<lan-ip>:3000`) don't get
 * it at all and unguarded calls crash the page. In that case fall back to
 * building a v4 UUID from `crypto.getRandomValues`, which is available in
 * insecure contexts too.
 *
 * Not for security-sensitive identifiers (tokens, secrets) — use a dedicated
 * mechanism for those.
 */
export function generateUuid(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return fallbackUuidV4();
}

// === Internal helpers ===

function fallbackUuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122 §4.4: set the version (4) and variant (10xx) bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}
