/**
 * Authorization-server binding for client credentials (SEP-2352).
 *
 * Client credentials belong to the authorization server that issued them. When
 * a protected resource moves to a different one, presenting the old client
 * identity to the new server is wrong, so the revision requires refusing reuse
 * across a change.
 *
 * The requirement lands on only half of our flows. Dynamically registered
 * credentials are never persisted here — they live in the flow's state cache
 * and a fresh registration happens on every authorization — so they cannot go
 * stale across a server change, and that half is satisfied by construction.
 * Operator-configured credentials do persist, and those are what this guards:
 * for them the spec asks for a surfaced error rather than a silent mismatch,
 * since we cannot mint a replacement for a client someone else registered.
 */

export type CredentialBindingDecision =
  | { ok: true }
  | { ok: false; reason: "preregistered_issuer_mismatch" };

/**
 * Decide whether operator-configured credentials may be used against the
 * authorization server discovery just reported.
 *
 * The comparison is against the authorization server the operator declared,
 * which is the only record we have of what the credentials were registered
 * with. Absent either side there is nothing to compare, and the call proceeds
 * rather than failing closed on missing configuration.
 */
export function checkPreregisteredCredentialBinding(params: {
  /** Authorization server the operator configured these credentials against. */
  configuredAuthServer?: string | null;
  /** Issuer discovered for the resource now. */
  discoveredIssuer?: string | null;
  /** The client id in use, to spot a portable CIMD identifier. */
  clientId?: string | null;
}): CredentialBindingDecision {
  const { configuredAuthServer, discoveredIssuer, clientId } = params;

  // A CIMD client id is a self-hosted HTTPS URL and means the same thing to
  // every authorization server, so a change of server does not invalidate it.
  if (isClientIdMetadataDocument(clientId)) {
    return { ok: true };
  }

  if (!configuredAuthServer || !discoveredIssuer) {
    return { ok: true };
  }

  return sameAuthorizationServer(configuredAuthServer, discoveredIssuer)
    ? { ok: true }
    : { ok: false, reason: "preregistered_issuer_mismatch" };
}

/**
 * Compare a configured authorization server URL against a discovered issuer.
 *
 * A trailing slash is tolerated here, unlike the RFC 9207 authorization-response
 * check, which must be byte-exact. This value is typed by an operator into
 * configuration rather than supplied by a party in the flow, so a trailing
 * slash is a typo rather than an attack, and rejecting it would break working
 * setups for no security gain.
 */
export function sameAuthorizationServer(a: string, b: string): boolean {
  return stripTrailingSlash(a) === stripTrailingSlash(b);
}

export function isClientIdMetadataDocument(clientId?: string | null): boolean {
  return typeof clientId === "string" && clientId.startsWith("https://");
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
