import { createHash } from "node:crypto";

/**
 * Deterministic hash for confidential OAuth client secrets that better-auth
 * verifies (the authorization_code and refresh_token grants).
 *
 * better-auth's oauthProvider verifies a presented secret by hashing it and
 * comparing (constant time) against the stored value, so the stored value MUST
 * be exactly this hash. A salted hash (e.g. bcrypt) can never satisfy
 * `hash(presented) === stored`, which is why MCP OAuth clients that go through
 * better-auth store their secret this way instead. OAuth client secrets are
 * high-entropy random strings, so a fast SHA-256 is appropriate here — the same
 * approach the platform already uses to hash OAuth access tokens at rest.
 *
 * The matching better-auth config is `oauthProvider({ storeClientSecret: { hash } })`.
 */
export function hashOauthClientSecret(secret: string): string {
  // codeql[js/insufficient-password-hash] Hashes a high-entropy OAuth client secret for lookup, not a user password.
  return createHash("sha256").update(secret).digest("base64url");
}
