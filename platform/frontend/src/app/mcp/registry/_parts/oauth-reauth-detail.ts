// Human-readable names for the six token-endpoint error codes defined by
// RFC 6749 §5.2, worded for the refresh_token grant type this field is
// always populated from (the spec's "provided authorization grant" is, in
// this context, always the refresh token — `refreshOAuthToken` only ever
// sends grant_type=refresh_token). Plus our own two non-standard categories:
// `refresh_failed` (the generic fallback `sanitizeOAuthErrorCode` uses when
// the server's code doesn't match the RFC 6749 §5.2 token shape) and
// `no_refresh_token` (no refresh token was available to attempt).
const OAUTH_ERROR_CODE_NAMES: Record<string, string> = {
  invalid_request: "The refresh request was malformed",
  invalid_client: "The stored client credentials are no longer valid",
  invalid_grant: "The refresh token is invalid, expired, or has been revoked",
  unauthorized_client: "This connection isn't authorized for token refresh",
  unsupported_grant_type:
    "The authorization server no longer supports refreshing this connection",
  invalid_scope: "The originally granted permissions are no longer valid",
  refresh_failed: "The connection could not be refreshed",
  no_refresh_token: "No refresh token is available for this connection",
};

/**
 * Human-readable name for an OAuth error code, falling back to the raw code
 * for anything outside the known set (e.g. a vendor-specific extension code
 * like RFC 8707's `invalid_target`) so an unmapped code stays visible rather
 * than disappearing.
 */
export function humanizeOAuthErrorCode(code: string): string {
  return OAUTH_ERROR_CODE_NAMES[code] ?? code;
}

/**
 * Human-readable detail line for an OAuth refresh failure, shown beneath the
 * Re-authenticate button on the connections surface: the humanized error code
 * and the failure time (e.g. "The refresh token is invalid, expired, or has
 * been revoked · failed Jun 25, 2026, 8:36 PM"). The fuller `error_description`
 * text, when present, is shown separately via an info popover — see
 * `oauthRefreshErrorDescription` usage in the dialogs.
 */
export function formatOAuthFailureDetail(
  errorMessage: string | null | undefined,
  failedAt: string | null | undefined,
): string {
  const reason = errorMessage
    ? humanizeOAuthErrorCode(errorMessage)
    : "authentication expired";
  if (!failedAt) return reason;
  const date = new Date(failedAt);
  if (Number.isNaN(date.getTime())) return reason;
  return `${reason} · failed ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
