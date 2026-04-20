const SSO_SIGN_IN_ATTEMPT_KEY = "archestra:sso-sign-in-attempt";

export function recordSsoSignInAttempt(callbackURL: string) {
  try {
    window.sessionStorage.setItem(SSO_SIGN_IN_ATTEMPT_KEY, callbackURL);
  } catch {
    // Ignore storage failures. SSO still works; only the fallback error UI is lost.
  }
}

export function consumeSsoSignInAttempt(callbackURL?: string) {
  if (!callbackURL) {
    return false;
  }

  try {
    const attemptedCallbackURL = window.sessionStorage.getItem(
      SSO_SIGN_IN_ATTEMPT_KEY,
    );

    if (attemptedCallbackURL !== callbackURL) {
      return false;
    }

    window.sessionStorage.removeItem(SSO_SIGN_IN_ATTEMPT_KEY);
    return true;
  } catch {
    return false;
  }
}
