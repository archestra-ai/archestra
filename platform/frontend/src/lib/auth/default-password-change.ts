const DEFAULT_PASSWORD_CHANGE_PENDING_KEY =
  "archestra.defaultPasswordChangePending";

export function setDefaultPasswordChangePending() {
  window.sessionStorage.setItem(DEFAULT_PASSWORD_CHANGE_PENDING_KEY, "true");
}

export function clearDefaultPasswordChangePending() {
  window.sessionStorage.removeItem(DEFAULT_PASSWORD_CHANGE_PENDING_KEY);
}

export function isDefaultPasswordChangePending() {
  return (
    window.sessionStorage.getItem(DEFAULT_PASSWORD_CHANGE_PENDING_KEY) ===
    "true"
  );
}
