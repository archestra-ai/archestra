const SSO_SIGN_IN_ATTEMPT_KEY = "archestra:sso-sign-in-attempt";

export function recordSsoSignInAttempt(callbackURL: string) {
  try {
    window.sessionStorage.setItem(
      SSO_SIGN_IN_ATTEMPT_KEY,
      normalizeCallbackURL(callbackURL),
    );
  } catch {
    // Ignore storage failures. SSO still works; only the fallback error UI is lost.
  }
}

export function hasSsoSignInAttempt(callbackURL?: string) {
  if (!callbackURL) {
    return false;
  }

  try {
    const attemptedCallbackURL = window.sessionStorage.getItem(
      SSO_SIGN_IN_ATTEMPT_KEY,
    );

    if (attemptedCallbackURL !== normalizeCallbackURL(callbackURL)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function clearSsoSignInAttempt() {
  try {
    window.sessionStorage.removeItem(SSO_SIGN_IN_ATTEMPT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function normalizeCallbackURL(callbackURL: string) {
  const url = new URL(callbackURL, window.location.origin);
  url.searchParams.delete("exp");
  url.searchParams.delete("sig");

  return url.pathname + url.search;
}
