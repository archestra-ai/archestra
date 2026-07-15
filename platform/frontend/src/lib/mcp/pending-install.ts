/**
 * Durable "install this catalog item" intent for the MCP Registry deep link
 * (`/mcp/registry?install={catalogId}`).
 *
 * The deep link auto-opens the install dialog once, then strips the query param
 * so a refresh does not re-trigger it. That makes the open a one-shot: if
 * anything tears the dialog down before the user acts — a route re-render that
 * remounts the registry subtree, a full-page return from an OAuth/enterprise
 * connect redirect, etc. — the intent is gone and the user is dropped onto the
 * bare registry with no popup, left to find and install the server by hand.
 *
 * Stashing the intent in sessionStorage lets the registry re-open the dialog
 * when it detects the intent is still unfulfilled. sessionStorage (tab-scoped,
 * cleared on tab close) holds only the catalog id and target scope — no
 * credentials. A small attempt cap keeps a genuinely un-openable intent (or a
 * remount loop) from re-opening forever.
 */

import type { McpServerInstallScope } from "@/app/mcp/registry/_parts/select-mcp-server-credential-type-and-teams";

export interface PendingInstall {
  catalogId: string;
  scope?: McpServerInstallScope;
  teamId?: string;
}

// Max times the registry will auto-reopen the dialog for one stashed intent
// after it is lost, before giving up — so a close-loop cannot reopen forever.
// The first open straight from the deep link does not count.
export const MAX_PENDING_INSTALL_REOPENS = 3;

export function setPendingInstall(pending: PendingInstall): void {
  try {
    sessionStorage.setItem(PENDING_INSTALL_KEY, JSON.stringify(pending));
    sessionStorage.removeItem(PENDING_INSTALL_REOPENS_KEY);
  } catch {
    // sessionStorage unavailable (privacy mode / SSR) — degrade to the prior
    // one-shot behavior rather than throwing.
  }
}

export function getPendingInstall(): PendingInstall | null {
  try {
    const raw = sessionStorage.getItem(PENDING_INSTALL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingInstall;
    return typeof parsed?.catalogId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPendingInstall(): void {
  try {
    sessionStorage.removeItem(PENDING_INSTALL_KEY);
    sessionStorage.removeItem(PENDING_INSTALL_REOPENS_KEY);
  } catch {
    // ignore
  }
}

/**
 * Record one auto-reopen attempt and report whether it is still under the cap.
 * Returns true when the caller may reopen the dialog; false once the intent has
 * been reopened MAX_PENDING_INSTALL_REOPENS times (the intent is cleared on
 * exhaustion so it stops being considered).
 */
export function registerPendingInstallReopen(): boolean {
  try {
    const attempts =
      Number(sessionStorage.getItem(PENDING_INSTALL_REOPENS_KEY) ?? "0") + 1;
    if (attempts > MAX_PENDING_INSTALL_REOPENS) {
      clearPendingInstall();
      return false;
    }
    sessionStorage.setItem(PENDING_INSTALL_REOPENS_KEY, String(attempts));
    return true;
  } catch {
    return false;
  }
}

const PENDING_INSTALL_KEY = "archestra:pending-install";
const PENDING_INSTALL_REOPENS_KEY = "archestra:pending-install-reopens";
