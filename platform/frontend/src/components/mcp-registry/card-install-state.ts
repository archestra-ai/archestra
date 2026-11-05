import type { McpServerCardVariant } from "./mcp-server-card";

/**
 * Decides whether an MCP registry card is in its "installing" state — which
 * hides the Install button and shows install progress.
 *
 * `installationStatus` comes from the aggregated installation for the catalog
 * item, and that aggregation falls back to ANOTHER user's server when the
 * viewer has no install of their own (`getAggregatedInstallation` prefers the
 * viewer's server but settles for any). A teammate's pending install must not
 * put the viewer's card into the installing state: it would hide the viewer's
 * Install button for the whole pod-startup + tool-discovery window of a
 * connection that isn't theirs, locking them out of adding their own
 * credential (and intermittently failing e2e installs queued right after a
 * teammate's).
 *
 * So a backend `pending` / `discovering-tools` status only counts when the
 * aggregated installation belongs to the viewer; an install the viewer just
 * triggered in this session (`viewerTriggeredInstall`) always counts.
 */
export function isCardShowingInstallInProgress({
  deploymentFailed,
  viewerTriggeredInstall,
  variant,
  installationStatus,
  hasInstalledServer,
  installationOwnedByViewer,
}: {
  /** The K8s deployment already failed (e.g. CrashLoopBackOff): show the error, not a spinner. */
  deploymentFailed: boolean;
  /** The viewer started an install for this item in this session (`installingItemId === item.id`). */
  viewerTriggeredInstall: boolean;
  variant: McpServerCardVariant;
  installationStatus:
    | "error"
    | "pending"
    | "success"
    | "idle"
    | "discovering-tools"
    | null
    | undefined;
  /** An aggregated installation exists for this catalog item. */
  hasInstalledServer: boolean;
  /** The aggregated installation's `ownerId` is the viewing user. */
  installationOwnedByViewer: boolean;
}): boolean {
  if (deploymentFailed) {
    return false;
  }
  if (viewerTriggeredInstall) {
    return true;
  }
  return (
    variant === "local" &&
    installationOwnedByViewer &&
    (installationStatus === "pending" ||
      (installationStatus === "discovering-tools" && hasInstalledServer))
  );
}
