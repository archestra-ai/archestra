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
