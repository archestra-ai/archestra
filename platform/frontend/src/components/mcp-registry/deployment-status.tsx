import {
  DocsPage,
  getDocsUrl,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type DeploymentState =
  | "running"
  | "pending"
  | "failed"
  | "degraded"
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  | "hibernated"
  | "waking";

export const HIBERNATED_STATUS_DESCRIPTION =
  "Scaled down after being idle — wakes automatically on next use";

export const WAKING_STATUS_DESCRIPTION =
  "Waking from idle — ready in a few seconds";
// SPDX-SnippetEnd

export function getDeploymentDotConfig(state: DeploymentState) {
  return {
    running: { dotClass: "bg-green-500", pulse: false },
    pending: { dotClass: "bg-yellow-500", pulse: true },
    failed: { dotClass: "bg-red-500", pulse: false },
    degraded: { dotClass: "bg-orange-500", pulse: false },
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    hibernated: { dotClass: "bg-muted-foreground", pulse: false },
    // Muted like hibernated (it's the same healthy idle pod returning to
    // life), but pulsing — deliberately distinct from the amber "Starting".
    waking: { dotClass: "bg-muted-foreground", pulse: true },
    // SPDX-SnippetEnd
  }[state];
}

export function getDeploymentLabel(state: DeploymentState) {
  return {
    running: "Running",
    pending: "Starting",
    failed: "Failed",
    degraded: "Degraded",
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    hibernated: "Hibernated",
    waking: "Waking",
    // SPDX-SnippetEnd
  }[state];
}

/**
 * Which count phrasing a surface renders once the deployment is neither
 * hibernated nor waking. The idle states read the same everywhere; only the
 * "there are pods up" wording differs per surface.
 */
export type DeploymentChipFormat =
  /** Registry card — `2/3` */
  | "ratio"
  /** Catalog detail page — `2/3 running` */
  | "ratio-with-state"
  /** Server settings sidebar — `2 running`, lowercase throughout */
  | "count-with-state";

/**
 * Label for the compact deployment chip. Hibernated and waking deserve words
 * rather than a count: `0/1` reads as an outage, which is exactly what an
 * idle-scaled server is not.
 */
export function getDeploymentStatusChipLabel({
  summary,
  format,
}: {
  summary: DeploymentStatusSummary;
  format: DeploymentChipFormat;
}): string {
  const chip = DEPLOYMENT_CHIP_FORMATS[format];
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (summary.overallState === "hibernated") return chip.hibernated;
  if (summary.overallState === "waking") return chip.waking;
  // SPDX-SnippetEnd
  return chip.active(summary);
}

/**
 * Accessible name for the deployment chip. Screen-reader users get the same
 * distinction the sighted chip makes — idle-scaled is not "0 of 1 running".
 */
export function getDeploymentStatusAriaLabel({
  summary,
  serverName,
}: {
  summary: DeploymentStatusSummary;
  serverName: string;
}): string {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (summary.overallState === "hibernated")
    return `All ${summary.total} deployments hibernated for ${serverName}, view logs`;
  if (summary.overallState === "waking")
    return `All ${summary.total} deployments waking from idle for ${serverName}, view logs`;
  // SPDX-SnippetEnd
  return `${summary.running} of ${summary.total} deployments running for ${serverName}, view logs`;
}

/**
 * Explanatory tooltip copy for the idle states, or null when the state speaks
 * for itself and the surface should keep its own count-based tooltip.
 */
export function getDeploymentStatusTooltipCopy(
  state: DeploymentState,
): string | null {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (state === "hibernated") return HIBERNATED_STATUS_DESCRIPTION;
  if (state === "waking") return WAKING_STATUS_DESCRIPTION;
  // SPDX-SnippetEnd
  return null;
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

/** Presence-style runtime indicator shared by MCP cards and table name cells. */
export function DeploymentStatusIconDot({
  summary,
}: {
  summary: DeploymentStatusSummary;
}) {
  const state = summary.overallState;
  const idleCopy = getDeploymentStatusTooltipCopy(state);
  const label = getDeploymentStatusIconTooltipLabel(summary);
  const idleRelated = state === "hibernated" || state === "waking";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-card"
            role="img"
            aria-label={`Runtime status: ${getDeploymentLabel(state)}`}
          >
            <DeploymentStatusDot state={state} />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            <span>{label}.</span>
            {idleCopy && <span> {idleCopy}</span>}
            {idleRelated && (
              <>
                <span> </span>
                <ExternalDocsLink
                  href={getDocsUrl(
                    DocsPage.PlatformOrchestrator,
                    "idle-hibernation",
                  )}
                  showIcon={false}
                >
                  Learn more
                </ExternalDocsLink>
              </>
            )}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function getDeploymentStatusIconTooltipLabel(
  summary: DeploymentStatusSummary,
): string {
  switch (summary.overallState) {
    case "running":
      return `Running ${summary.running}/${summary.total} pods`;
    case "pending":
      return `Starting ${summary.pending}/${summary.total} pods`;
    case "failed":
      return `Failed ${summary.failed}/${summary.total} pods`;
    case "degraded":
      return `Running ${summary.running}/${summary.total} pods; ${summary.failed} failed`;
    case "hibernated":
      return "Hibernated";
    case "waking":
      return "Waking";
  }
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
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  hibernated: number;
  waking: number;
  // SPDX-SnippetEnd
  overallState: DeploymentState;
}

// Highest observed state wins when collapsing entries that map to one pod, so
// a failed alias still surfaces over a running/pending sibling. Shared by
// every surface that canonicalizes multi-tenant sibling states.
export const STATE_PRIORITY: Record<string, number> = {
  failed: 5,
  running: 4,
  succeeded: 4,
  pending: 3,
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // Waking (hibernated pod scaling back up on demand) is transitional like
  // pending, so it ranks the same — and above the hibernated state it leaves.
  waking: 3,
  hibernated: 2,
  // SPDX-SnippetEnd
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
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  let hibernated = 0;
  let waking = 0;
  // SPDX-SnippetEnd
  for (const entry of uniqueEntries) {
    total++;
    // "succeeded" is treated as running — K8s Jobs report "succeeded" on completion,
    // but the MCP server is still available and serving requests.
    if (entry.state === "running" || entry.state === "succeeded") running++;
    else if (entry.state === "pending") pending++;
    else if (entry.state === "failed") failed++;
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    else if (entry.state === "hibernated") hibernated++;
    else if (entry.state === "waking") waking++;
    // SPDX-SnippetEnd
  }
  if (total === 0) return null;

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // Determine overall state. Hibernated deployments are healthy (idle-scaled,
  // wake on next use), so they count neither as running nor as failed. Waking
  // (a hibernated pod scaling back up) is transitional like pending — it also
  // counts neither as running nor as failed, and never changes which of the
  // existing outcomes fires:
  // - "degraded" = some failed AND some healthy (running/succeeded/hibernated)
  // - "failed" = all active deployments failed
  // - "pending" = any pending (and none failed)
  // - "running" = any running/succeeded (hibernated siblings are not a problem)
  // - "waking" = at least one waking and only waking/hibernated remain
  // - "hibernated" = all active deployments hibernated
  // SPDX-SnippetEnd
  const overallState: DeploymentState =
    failed > 0 &&
    running /* SPDX-SnippetBegin */ +
      /* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */
      /* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */ hibernated /* SPDX-SnippetEnd */ >
      0
      ? "degraded"
      : failed > 0
        ? "failed"
        : pending > 0
          ? "pending"
          : /* SPDX-SnippetBegin */
            /* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */
            /* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */
            running > 0
            ? /* SPDX-SnippetEnd */ "running" /* SPDX-SnippetBegin */
            : /* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */
              /* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */
              waking > 0
              ? "waking"
              : "hibernated" /* SPDX-SnippetEnd */;

  return {
    total,
    running,
    pending,
    failed,
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    hibernated,
    waking,
    // SPDX-SnippetEnd
    overallState,
  };
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

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const idleCopy = getDeploymentStatusTooltipCopy(summary.overallState);
  // SPDX-SnippetEnd

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help">
            <DeploymentStatusDot state={summary.overallState} />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {
            /* SPDX-SnippetBegin */
            /* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */
            /* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */
            idleCopy ? (
              <p>{idleCopy}</p>
            ) : (
              // SPDX-SnippetEnd
              <p>
                {summary.running} / {summary.total} deployments{" "}
                {getDeploymentLabel(summary.overallState).toLowerCase()}
              </p>
              /* SPDX-SnippetBegin */
              /* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */
              /* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */
            ) /* SPDX-SnippetEnd */
          }
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// === Internal ===

// One descriptor per surface rather than a "hibernating vs everyone else"
// ternary repeated in three components — adding a state means adding a row.
const DEPLOYMENT_CHIP_FORMATS: Record<
  DeploymentChipFormat,
  {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    hibernated: string;
    waking: string;
    // SPDX-SnippetEnd
    active: (summary: DeploymentStatusSummary) => string;
  }
> = {
  ratio: {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    hibernated: "Hibernated",
    waking: "Waking…",
    // SPDX-SnippetEnd
    active: (summary) => `${summary.running}/${summary.total}`,
  },
  "ratio-with-state": {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    hibernated: "Hibernated",
    waking: "Waking…",
    // SPDX-SnippetEnd
    active: (summary) =>
      `${summary.running}/${summary.total} ${getDeploymentLabel(summary.overallState).toLowerCase()}`,
  },
  "count-with-state": {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    hibernated: "hibernated",
    waking: "waking",
    // SPDX-SnippetEnd
    active: (summary) =>
      `${summary.running} ${getDeploymentLabel(summary.overallState).toLowerCase()}`,
  },
};
