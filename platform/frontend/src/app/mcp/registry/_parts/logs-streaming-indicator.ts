import type { McpDeploymentStatusEntry } from "@archestra/shared";

/**
 * Decides whether the pod-logs footer should suppress the live red
 * "Streaming" chip because there is no pod to tail.
 *
 * A hibernated deployment (idle-scaled to 0 replicas) and a waking one
 * (replicas patched back but not yet available) have no ready pod, and the
 * backend clears pod telemetry (podName) whenever no pod exists. Showing the
 * red chip in those states reads as live-tailing an outage, when hibernation
 * is a calm, expected state. Running deployments with a pod keep the chip.
 *
 * A missing status entry keeps the chip: deployment statuses arrive over a
 * separate websocket push, so "no entry yet" means "unknown", not "no pod".
 */
export function hasNoPodToStream(
  status: McpDeploymentStatusEntry | null | undefined,
): boolean {
  if (!status) return false;
  if (!status.podName) return true;
  return DORMANT_STATES.includes(status.state);
}

// Widened to string so this compiles independently of whether the shared
// McpDeploymentState union has grown the "waking" literal yet.
const DORMANT_STATES: readonly string[] = ["hibernated", "waking"];
