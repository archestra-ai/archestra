// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

/**
 * Client-side helpers for browser-key protected MCP credentials.
 *
 * A personal static credential (API key / PAT) on a remote MCP server can be
 * protected by a key that lives ONLY in this browser's localStorage — the
 * server never stores it. The SAME single per-user-browser key is reused for
 * every credential the user protects, so each browser holds at most one key.
 * Every request that may execute tools against a protected connection must
 * carry the key in the `x-archestra-credential-key` header; without it the
 * server refuses the protected connection, and with a wrong key it returns
 * 409.
 */

/** Header carrying the browser credential key (mirrors the backend constant). */
export const CREDENTIAL_KEY_HEADER = "x-archestra-credential-key";

/**
 * Read the browser's credential key, generating and persisting one on first
 * use. All protected credentials in this browser share this single key.
 */
export function getOrCreateBrowserCredentialKey(): string {
  const existing = getBrowserCredentialKey();
  if (existing) {
    return existing;
  }
  const key = generateBrowserCredentialKey();
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // QuotaExceededError or private browsing restriction — the connection
    // will show as browser-locked on reload, but the live session keeps
    // working with the in-memory key.
  }
  return key;
}

/** Read the stored credential key, or null when this browser has none. */
export function getBrowserCredentialKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Headers to spread into any request that may execute tools against a
 * browser-key protected connection (chat stream, inspector, tool reload).
 * Returns undefined when no key is stored — the backend ignores the header
 * for unprotected installs, so it is safe to send whenever present.
 */
export function browserCredentialHeaders(): Record<string, string> | undefined {
  const key = getBrowserCredentialKey();
  return key ? { [CREDENTIAL_KEY_HEADER]: key } : undefined;
}

// === Internal ===

/** The single per-user-browser key shared by all protected credentials. */
const STORAGE_KEY = "archestra_mcp_credential_key";

/**
 * Generate a fresh credential key: 32 random bytes, base64url-encoded
 * without padding (the wire format the backend parses).
 *
 * Uses `crypto.getRandomValues`, which — unlike `crypto.randomUUID`, see
 * src/lib/uuid.ts — is available in non-secure contexts too, so plain-HTTP
 * deployments (e.g. `http://<lan-ip>:3000`) work without a fallback.
 */
function generateBrowserCredentialKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
