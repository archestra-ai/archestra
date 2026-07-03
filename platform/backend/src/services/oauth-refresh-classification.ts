/**
 * Pure classification and sanitization for OAuth token-refresh outcomes.
 * These helpers take a token-endpoint response (or a thrown error) and decide
 * whether a refresh failure is terminal (re-authentication required) or
 * transient (a recoverable transport blip), sanitizing any error text before
 * it is persisted. No I/O — the actual refresh call lives in
 * `routes/oauth.ts` (`refreshOAuthToken`), which consumes these.
 */

/**
 * Outcome of an OAuth refresh attempt. A `terminal` failure means the grant is
 * dead (re-authentication required); a `transient` failure is a recoverable
 * transport/infrastructure blip that must not change persisted connection
 * health and is re-attempted on next use.
 */
export type OAuthRefreshOutcome =
  | { ok: true }
  | {
      ok: false;
      kind: "terminal";
      category: "refresh_failed" | "no_refresh_token";
      message: string;
      description?: string;
    }
  | {
      ok: false;
      kind: "transient";
      reason:
        | "network"
        | "timeout"
        | "server_error"
        | "rate_limited"
        | "unexpected_response";
    };

// An OAuth `error` code is a restricted ASCII token (RFC 6749 §5.2). Anything
// outside this shape (URLs, free text, token material) is dropped.
const OAUTH_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * @public — exported for testability (only consumed internally by
 * `classifyRefreshResponse`).
 */
export function sanitizeOAuthErrorCode(error?: string | null): string {
  if (typeof error === "string" && OAUTH_ERROR_CODE_PATTERN.test(error)) {
    return error;
  }
  return "refresh_failed";
}

// `error_description` is free-form prose (RFC 6749 §5.2 places no shape
// constraint on it), so unlike `sanitizeOAuthErrorCode` above this can't be a
// whitelist — the field exists specifically to keep human-readable debugging
// detail. Instead this blacklists known-dangerous shapes an authorization
// server (malicious, compromised, or merely careless) could echo back:
// credential-bearing URLs, tokens/API keys, emails, and HTML. This is
// defense in depth, not a guarantee — a redacted placeholder can still slip
// past a pattern we didn't anticipate.
const OAUTH_ERROR_DESCRIPTION_REDACTED = "[redacted]";
const OAUTH_ERROR_DESCRIPTION_SCAN_LIMIT = 5_000;
const OAUTH_ERROR_DESCRIPTION_MAX_LENGTH = 500;

const OAUTH_ERROR_DESCRIPTION_REDACT_PATTERNS: RegExp[] = [
  // URLs — may carry credentials/tokens in userinfo or the query string.
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
  // JWTs — three dot-separated base64url segments.
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Well-known API key/token prefixes (Stripe, GitHub, AWS, Slack, OpenAI).
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // Email addresses.
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // HTML/script tags — defense in depth if this is ever rendered.
  /<[^>]*>/g,
  // Generic high-entropy secret-shaped runs, kept last so the more specific
  // categories above classify first.
  /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g,
];

/**
 * @public — exported for testability (only consumed internally by
 * `classifyRefreshResponse`).
 */
export function sanitizeOAuthErrorDescription(
  raw?: string | null,
): string | null {
  // `body` is a `JSON.parse` of an untrusted third-party response with no
  // runtime schema validation — the `string` type on `error_description` is
  // a compile-time hint only. A non-string value (number, object, array)
  // must not reach the string methods below, or the throw gets caught by
  // `refreshOAuthToken`'s outer catch and misclassified as transient via
  // `classifyThrownRefreshError`, silently downgrading a genuine terminal
  // grant rejection to "retry later".
  if (typeof raw !== "string" || !raw) {
    return null;
  }

  // Bound the work done on an adversarial payload before the final length
  // cap, independent of how much of it we'd keep anyway.
  let result = raw.slice(0, OAUTH_ERROR_DESCRIPTION_SCAN_LIMIT);
  for (const pattern of OAUTH_ERROR_DESCRIPTION_REDACT_PATTERNS) {
    result = result.replace(pattern, OAUTH_ERROR_DESCRIPTION_REDACTED);
  }

  result = result.trim().slice(0, OAUTH_ERROR_DESCRIPTION_MAX_LENGTH);
  return result || null;
}

// OAuth error codes that signal a temporary server condition, not a dead grant.
// RFC 6749 defines these for the authorization endpoint (§4.1.2.1); the token
// endpoint's own set (§5.2) does not include them. Some authorization servers
// nonetheless return them from the token endpoint on a 400, so we treat them
// as transient rather than a revoked grant.
const TRANSIENT_OAUTH_ERRORS = new Set([
  "temporarily_unavailable",
  "server_error",
]);

/**
 * Classify a token-endpoint response. A genuine grant rejection is a structured
 * OAuth `error` body, which is terminal — but infrastructure failures
 * (5xx, 429, or a transient OAuth error code) take precedence over the body so
 * a temporary outage is not mistaken for a revoked grant. A proxy/WAF 4xx or a
 * captive-portal 200 with no token are likewise transient, not "re-authenticate".
 */
export function classifyRefreshResponse(params: {
  status: number;
  body: {
    access_token?: string;
    error?: string;
    error_description?: string;
  } | null;
}): OAuthRefreshOutcome {
  const { status, body } = params;

  if (status >= 200 && status < 300 && body?.access_token) {
    return { ok: true };
  }

  if (status >= 500) {
    return { ok: false, kind: "transient", reason: "server_error" };
  }
  if (status === 429) {
    return { ok: false, kind: "transient", reason: "rate_limited" };
  }
  if (body?.error && TRANSIENT_OAUTH_ERRORS.has(body.error)) {
    return { ok: false, kind: "transient", reason: "server_error" };
  }

  if (body?.error) {
    return {
      ok: false,
      kind: "terminal",
      category: "refresh_failed",
      message: sanitizeOAuthErrorCode(body.error),
      description:
        sanitizeOAuthErrorDescription(body.error_description) ?? undefined,
    };
  }

  return { ok: false, kind: "transient", reason: "unexpected_response" };
}

export function classifyThrownRefreshError(
  error: unknown,
): Extract<OAuthRefreshOutcome, { kind: "transient" }> {
  const isTimeout =
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
  return {
    ok: false,
    kind: "transient",
    reason: isTimeout ? "timeout" : "network",
  };
}

/**
 * Map a refresh outcome to the `mcp_server` fields to persist. Returns `null`
 * for success and for transient failures (which must persist nothing).
 */
export function refreshFailureToServerFields(outcome: OAuthRefreshOutcome): {
  oauthRefreshError: "refresh_failed" | "no_refresh_token";
  oauthRefreshErrorMessage: string;
  oauthRefreshErrorDescription: string | null;
  oauthRefreshFailedAt: Date;
} | null {
  if (outcome.ok || outcome.kind !== "terminal") {
    return null;
  }
  return {
    oauthRefreshError: outcome.category,
    oauthRefreshErrorMessage: outcome.message,
    oauthRefreshErrorDescription: outcome.description ?? null,
    oauthRefreshFailedAt: new Date(),
  };
}
