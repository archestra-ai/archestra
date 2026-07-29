/**
 * Every query parameter the OAuth callback consumes, read in one place.
 *
 * Extracted from the page component so the set is pinned by tests: the RFC
 * 9207 regression was exactly a parameter (`iss`) that the server sent, the
 * backend accepted, and this layer silently dropped — invisible to both the
 * component's rendering and the backend's route tests.
 */
export interface OAuthCallbackParams {
  code: string | null;
  error: string | null;
  errorDescription: string | null;
  state: string | null;
  /** RFC 9207 authorization-server identifier, when the server sends one. */
  iss: string | null;
}

export function extractOAuthCallbackParams(searchParams: {
  get(name: string): string | null;
}): OAuthCallbackParams {
  return {
    code: searchParams.get("code"),
    error: searchParams.get("error"),
    errorDescription: searchParams.get("error_description"),
    state: searchParams.get("state"),
    iss: searchParams.get("iss"),
  };
}

/**
 * The exact body for the token-exchange call. `iss` rides along whenever the
 * server sent it — the backend compares it against the server the flow
 * started with, so it has to reach the wire.
 */
export function buildOAuthCallbackPayload(params: {
  code: string;
  state: string;
  iss: string | null;
}): { code: string; state: string; iss?: string } {
  const { code, state, iss } = params;
  return { code, state, ...(iss ? { iss } : {}) };
}

export interface OAuthCallbackErrorState {
  title: string;
  description: string;
}

/**
 * Convert the stored OAuth return URL into an app-internal path for router
 * navigation. Returns null when the URL is malformed or points at a different
 * origin, so callers fall back to a safe default instead of open-redirecting.
 */
export function toInternalReturnPath(
  returnUrl: string | null,
  origin: string,
): string | null {
  if (!returnUrl) {
    return null;
  }

  try {
    const parsed = new URL(returnUrl, origin);
    if (parsed.origin !== origin) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function getOAuthCallbackErrorState(params: {
  code: string | null;
  error: string | null;
  errorDescription: string | null;
  state: string | null;
}): OAuthCallbackErrorState | null {
  const { code, error, errorDescription, state } = params;

  if (code && state) {
    return null;
  }

  if (error) {
    return {
      title: "OAuth Authentication Failed",
      description:
        errorDescription ||
        `OAuth provider returned "${error}". Check the provider configuration and try again.`,
    };
  }

  if (!code) {
    return {
      title: "Missing Authorization Code",
      description:
        "The OAuth provider redirected back without an authorization code. Check the provider configuration and try again.",
    };
  }

  return {
    title: "Missing OAuth State",
    description:
      "The OAuth provider redirected back without a state value. Start the installation again and retry the sign-in flow.",
  };
}
