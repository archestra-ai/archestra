/**
 * RFC 9207 authorization-response issuer validation (SEP-2468).
 *
 * Mitigates the OAuth mix-up attack: with one client registered against many
 * authorization servers, an attacker who can get an authorization response from
 * server A delivered to the callback for server B may have the client redeem
 * A's code at B's token endpoint, leaking it. MCP's topology — a single gateway
 * against many upstream servers — is precisely the shape that makes this
 * reachable, which is why the spec now requires the check.
 *
 * The validation runs BEFORE the authorization code is transmitted to any token
 * endpoint. That ordering is the whole mitigation: once the code has been sent,
 * the leak has already happened.
 */

export type IssuerValidationOutcome =
  | { ok: true }
  | { ok: false; reason: "issuer_mismatch" | "issuer_missing" };

/**
 * Decide whether an authorization response may proceed to the token endpoint.
 *
 * The four cases come straight from the spec's table:
 *
 * | advertised | `iss` present | action                        |
 * | ---------- | ------------- | ----------------------------- |
 * | true       | yes           | compare                       |
 * | true       | no            | reject                        |
 * | false      | yes           | compare (local policy)        |
 * | false      | no            | proceed                       |
 *
 * The third row is deliberate: a present `iss` is always compared, even when the
 * server never advertised support, so a server that emits `iss` before updating
 * its metadata still gets the protection.
 */
export function validateAuthorizationResponseIssuer(params: {
  /** `iss` from the authorization response, already form-decoded. */
  responseIssuer?: string | null;
  /** The issuer recorded when the flow started. */
  recordedIssuer?: string | null;
  /** `authorization_response_iss_parameter_supported` from AS metadata. */
  issParameterSupported?: boolean | null;
}): IssuerValidationOutcome {
  const { responseIssuer, recordedIssuer, issParameterSupported } = params;

  const present = typeof responseIssuer === "string" && responseIssuer !== "";

  if (!present) {
    // Rejection on absence stays keyed to the advertisement, per the spec.
    return issParameterSupported === true
      ? { ok: false, reason: "issuer_missing" }
      : { ok: true };
  }

  // A present `iss` with nothing recorded to compare against cannot be
  // verified, so it cannot be trusted.
  if (!recordedIssuer) {
    return { ok: false, reason: "issuer_mismatch" };
  }

  return issuersMatch(responseIssuer, recordedIssuer)
    ? { ok: true }
    : { ok: false, reason: "issuer_mismatch" };
}

/**
 * Simple string comparison, per RFC 3986 Section 6.2.1.
 *
 * Deliberately exact. The spec forbids scheme or host case folding, default-port
 * elision, trailing-slash, and percent-encoding normalization before comparison
 * — every one of those would widen what counts as a match, and the point of the
 * check is that it is narrow.
 */
export function issuersMatch(a: string, b: string): boolean {
  return a === b;
}

/**
 * Whether an authorization response is an error response.
 *
 * Error responses carry the same issuer guarantee: on mismatch the client must
 * not act on or display `error`, `error_description`, or `error_uri`, since
 * those came from an unverified party.
 */
export function isAuthorizationErrorResponse(params: {
  error?: string | null;
}): boolean {
  return typeof params.error === "string" && params.error !== "";
}
