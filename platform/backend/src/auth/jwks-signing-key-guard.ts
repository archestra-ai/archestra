import { symmetricDecrypt } from "better-auth/crypto";
import { createJwk } from "better-auth/plugins/jwt";
import logger from "@/logging";
import JwksModel from "@/models/jwks";
import { auth, JWT_PLUGIN_OPTIONS } from "./better-auth";

/**
 * Startup guard: keep the JWKS signing key readable by the secret currently in
 * use, by retiring a key the secret can no longer decrypt.
 *
 * better-auth's JWT plugin stores its signing keypair in the `jwks` table with
 * the private half encrypted under the better-auth secret
 * (`ARCHESTRA_AUTH_SESSION_SECRET`, falling back to the legacy combined
 * `ARCHESTRA_AUTH_SECRET`). Changing that secret — a deliberate rotation, or
 * splitting the session secret out of the combined one — leaves the stored key
 * undecryptable, and the plugin has no recovery path: it throws
 * `BetterAuthError("Failed to decrypt private key…")` on every signature,
 * forever.
 *
 * That fails far from its cause. The throw escapes better-auth's router as a
 * *bodyless* 500, so the only client-visible symptom is an OAuth login that
 * dies at the token exchange — and only for clients that request the `openid`
 * scope, since an id_token is the one thing on that path that needs a
 * signature. An MCP gateway login from the Codex CLI breaks while Claude Code,
 * which asks for no `openid` scope, keeps working.
 *
 * A JWKS keypair is derived material, not user data: nothing is lost by
 * replacing one. Previously issued tokens still verify, because the old row —
 * and so its public key — stays in the published key set; only signing moves
 * to the new key. So an unreadable key is retired and replaced here rather
 * than aborting startup the way `secrets-manager/encryption-key-guard.ts`
 * does for stored secrets, which are irreplaceable and must never be silently
 * re-keyed.
 */
export async function verifyJwksSigningKey(): Promise<void> {
  const latest = await JwksModel.getLatest();
  // No key yet: the plugin mints one under the current secret on first use.
  if (!latest) return;

  const authContext = await auth.$context;
  if (await canDecryptPrivateKey(latest.privateKey, authContext.secretConfig)) {
    return;
  }

  logger.error(
    { jwkId: latest.id, jwkCreatedAt: latest.createdAt },
    "The JWKS signing key cannot be decrypted with the current auth secret, so OIDC id_tokens cannot be signed " +
      "(OAuth logins requesting the `openid` scope fail at the token exchange). The auth secret was changed, or this " +
      "database came from an environment with a different one. Minting a replacement signing key; the previous key " +
      "stays published so tokens already issued keep verifying.",
  );

  // `createJwk` writes a row stamped with the current time, which the plugin's
  // greatest-`createdAt` rule then prefers over the unreadable one. Replicas
  // booting together can each mint a key; every one of them is valid and
  // readable, and the plugin simply signs with the newest.
  const replacement = await createJwk(
    toJwkContext(authContext),
    JWT_PLUGIN_OPTIONS,
  );
  logger.info(
    { jwkId: replacement.id, retiredJwkId: latest.id },
    "Minted a replacement JWKS signing key under the current auth secret",
  );
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/**
 * `auth.$context` is typed against this instance's concrete options object,
 * while the JWT plugin's helpers declare the generic `BetterAuthOptions`. The
 * adapter type is invariant in its options parameter, so the two never unify
 * even though the value is precisely what the helper expects at runtime — keep
 * the mismatch to this one cast.
 */
function toJwkContext(
  context: Awaited<typeof auth.$context>,
): Parameters<typeof createJwk>[0] {
  return { context } as unknown as Parameters<typeof createJwk>[0];
}

async function canDecryptPrivateKey(
  privateKey: string,
  key: Awaited<typeof auth.$context>["secretConfig"],
): Promise<boolean> {
  try {
    // The plugin stores the encrypted envelope as JSON; a row written with
    // encryption disabled is a bare JWK and needs no secret to read.
    const stored: unknown = JSON.parse(privateKey);
    if (isPlaintextJwk(stored)) return true;
    await symmetricDecrypt({ key, data: stored as never });
    return true;
  } catch {
    return false;
  }
}

/**
 * A private key stored with `jwks.disablePrivateKeyEncryption` is the JWK
 * itself, identified by its key-type member, rather than an encrypted envelope.
 */
function isPlaintextJwk(stored: unknown): boolean {
  return (
    typeof stored === "object" && stored !== null && "kty" in (stored as object)
  );
}
