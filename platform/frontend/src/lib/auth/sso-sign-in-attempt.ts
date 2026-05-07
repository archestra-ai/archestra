const SSO_SIGN_IN_ATTEMPT_KEY = "archestra:sso-sign-in-attempt";
const SSO_SIGN_IN_ATTEMPT_VALUE = "pending";
const SSO_SIGN_IN_REDIRECT_PATH_KEY = "archestra:sso-sign-in-redirect-path";

export function recordSsoSignInAttempt(redirectPath?: string) {
  try {
    window.sessionStorage.setItem(
      SSO_SIGN_IN_ATTEMPT_KEY,
      SSO_SIGN_IN_ATTEMPT_VALUE,
    );
    if (redirectPath) {
      window.sessionStorage.setItem(
        SSO_SIGN_IN_REDIRECT_PATH_KEY,
        redirectPath,
      );
    }
  } catch {
    // Ignore storage failures. SSO still works; only the fallback error UI is lost.
  }
}

export function hasSsoSignInAttempt() {
  try {
    return (
      window.sessionStorage.getItem(SSO_SIGN_IN_ATTEMPT_KEY) ===
      SSO_SIGN_IN_ATTEMPT_VALUE
    );
  } catch {
    return false;
  }
}

export function clearSsoSignInAttempt() {
  try {
    window.sessionStorage.removeItem(SSO_SIGN_IN_ATTEMPT_KEY);
    window.sessionStorage.removeItem(SSO_SIGN_IN_REDIRECT_PATH_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function getSsoSignInRedirectPath() {
  try {
    return window.sessionStorage.getItem(SSO_SIGN_IN_REDIRECT_PATH_KEY);
  } catch {
    return null;
  }
}

export function clearSsoSignInRedirectPath() {
  try {
    window.sessionStorage.removeItem(SSO_SIGN_IN_REDIRECT_PATH_KEY);
  } catch {
    // Ignore storage failures.
  }
}
