import type { McpDeploymentStatusEntry } from "@archestra/shared";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type DeploymentState = "running" | "pending" | "failed" | "degraded";

export function getDeploymentDotConfig(state: DeploymentState) {
  return {
    running: { dotClass: "bg-green-500", pulse: false },
    pending: { dotClass: "bg-yellow-500", pulse: true },
    failed: { dotClass: "bg-red-500", pulse: false },
    degraded: { dotClass: "bg-orange-500", pulse: false },
  }[state];
}

export function getDeploymentLabel(state: DeploymentState) {
  return {
    running: "Running",
    pending: "Starting",
    failed: "Failed",
    degraded: "Degraded",
  }[state];
}

export function DeploymentStatusDot({ state }: { state: DeploymentState }) {
  const config = getDeploymentDotConfig(state);
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {config.pulse && (
        <span
          className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.dotClass} opacity-75`}
        />
      )}
      <span
        className={`relative inline-flex rounded-full h-2 w-2 ${config.dotClass}`}
      />
    </span>
  );
}

export function DeploymentStatusBanner({
  status,
}: {
  status: McpDeploymentStatusEntry | null;
}) {
  if (!status) return null;
  if (status.state === "not_created" || status.state === "succeeded")
    return null;

  const state = status.state as DeploymentState;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-muted/50 flex-1 min-w-0">
      <DeploymentStatusDot state={state} />
      <span className="text-sm font-medium shrink-0">
        {getDeploymentLabel(state)}
      </span>
      {status.message && (
        <span className="text-sm text-muted-foreground shrink-0">
          — {status.message}
        </span>
      )}
      {status.error && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm text-destructive truncate min-w-0">
                — {status.error}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-md break-words">
              <p>{status.error}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

export interface DeploymentStatusSummary {
  total: number;
  running: number;
  pending: number;
  failed: number;
  overallState: DeploymentState;
}

// Highest observed state wins when collapsing entries that map to one pod, so
// a failed alias still surfaces over a running/pending sibling.
const STATE_PRIORITY: Record<string, number> = {
  failed: 4,
  running: 3,
  succeeded: 3,
  pending: 2,
  not_created: 1,
};

/**
 * Compute an aggregate deployment status summary from a set of server IDs
 * and their individual deployment statuses.
 */
export function computeDeploymentStatusSummary(
  serverIds: string[],
  statuses: Record<string, McpDeploymentStatusEntry>,
): DeploymentStatusSummary | null {
  if (serverIds.length === 0) return null;

  // Dedupe entries that map to the same pod so the count reflects pods, not
  // caller rows. A deployment's identity (deploymentName) is stable from
  // install time — known before a pod is scheduled — so multi-tenant catalogs,
  // which share one deployment across rows, collapse to a single pod even while
  // a freshly-installed row's podName is still null. Fall back to podName, then
  // count individually when neither identity is known.
  const byKey = new Map<string, McpDeploymentStatusEntry>();
  const unkeyed: McpDeploymentStatusEntry[] = [];
  for (const id of serverIds) {
    const entry = statuses[id];
    if (!entry || entry.state === "not_created") continue;
    const key = entry.deploymentName ?? entry.podName;
    if (!key) {
      unkeyed.push(entry);
      continue;
    }
    const existing = byKey.get(key);
    if (
      !existing ||
      (STATE_PRIORITY[entry.state] ?? 0) > (STATE_PRIORITY[existing.state] ?? 0)
    ) {
      byKey.set(key, entry);
    }
  }
  const uniqueEntries: McpDeploymentStatusEntry[] = [
    ...byKey.values(),
    ...unkeyed,
  ];

  let total = 0;
  let running = 0;
  let pending = 0;
  let failed = 0;
  for (const entry of uniqueEntries) {
    total++;
    // "succeeded" is treated as running — K8s Jobs report "succeeded" on completion,
    // but the MCP server is still available and serving requests.
    if (entry.state === "running" || entry.state === "succeeded") running++;
    else if (entry.state === "pending") pending++;
    else if (entry.state === "failed") failed++;
  }
  if (total === 0) return null;

  // Determine overall state:
  // - "degraded" = some running/succeeded AND some failed (partial failure)
  // - "failed" = all active deployments failed
  // - "pending" = any pending (and none failed)
  // - "running" = all running/succeeded
  const overallState: DeploymentState =
    failed > 0 && running > 0
      ? "degraded"
      : failed > 0
        ? "failed"
        : pending > 0
          ? "pending"
          : "running";

  return { total, running, pending, failed, overallState };
}

export function DeploymentStatusIndicator({
  serverIds,
  deploymentStatuses,
}: {
  serverIds: string[];
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
}) {
  const summary = computeDeploymentStatusSummary(serverIds, deploymentStatuses);
  if (!summary) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help">
            <DeploymentStatusDot state={summary.overallState} />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {summary.running} / {summary.total} deployments{" "}
            {getDeploymentLabel(summary.overallState).toLowerCase()}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
