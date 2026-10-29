/**
 * Which site notifications this browser has dismissed. The choice lives in
 * `localStorage`, which the server cannot read, so a server-rendered page
 * always puts the active notification in its HTML — even for a visitor who
 * dismissed it. {@link HIDE_DISMISSED_SITE_NOTIFICATIONS_SCRIPT} hides those
 * bars before the first paint; the bar itself unmounts once it hydrates.
 */

// Declared ahead of the script below, which reads it as the module loads.
const STORAGE_PREFIX = "site-notification-dismissed:";

/**
 * Runs in the document head, ahead of the first paint: a stylesheet rule that
 * hides every bar this browser has dismissed. Without it a server-rendered
 * page shows a dismissed bar until hydration removes it.
 */
export const HIDE_DISMISSED_SITE_NOTIFICATIONS_SCRIPT = `(() => {
  try {
    const prefix = ${JSON.stringify(STORAGE_PREFIX)};
    const selectors = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      if (localStorage.getItem(key) !== "true") continue;
      const id = JSON.stringify(key.slice(prefix.length));
      selectors.push("[data-site-notification-id=" + id + "]");
    }
    if (selectors.length === 0) return;
    const style = document.createElement("style");
    style.textContent = selectors.join(",") + "{display:none!important}";
    document.head.appendChild(style);
  } catch {
    // Storage blocked: nothing was dismissed in a way we can read.
  }
})();`;

export function isSiteNotificationDismissed(notificationId: string): boolean {
  if (typeof window === "undefined") return false;
  if (pageDismissals.has(notificationId)) return true;
  try {
    return localStorage.getItem(storageKey(notificationId)) === "true";
  } catch {
    return false;
  }
}

export function dismissSiteNotification(notificationId: string): void {
  // Remembered for this page too, so the bar hides even when storage is
  // blocked.
  pageDismissals.add(notificationId);
  try {
    localStorage.setItem(storageKey(notificationId), "true");
  } catch {
    // Storage blocked: the dismissal lasts until the page reloads.
  }
  for (const listener of listeners) listener();
}

/**
 * Subscribe to dismissals made on this page or in another tab, for
 * `useSyncExternalStore`.
 */
export function subscribeToSiteNotificationDismissals(
  listener: () => void,
): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

// ===

function storageKey(notificationId: string) {
  return `${STORAGE_PREFIX}${notificationId}`;
}

const listeners = new Set<() => void>();
const pageDismissals = new Set<string>();
