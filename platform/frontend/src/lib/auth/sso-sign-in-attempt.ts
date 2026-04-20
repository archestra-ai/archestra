const SSO_SIGN_IN_ATTEMPT_KEY = "archestra:sso-sign-in-attempt";
const SSO_SIGN_IN_ATTEMPT_VALUE = "pending";

export function recordSsoSignInAttempt() {
  try {
    window.sessionStorage.setItem(
      SSO_SIGN_IN_ATTEMPT_KEY,
      SSO_SIGN_IN_ATTEMPT_VALUE,
    );
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
  } catch {
    // Ignore storage failures.
  }
}
