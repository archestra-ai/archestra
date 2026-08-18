import type {
  archestraApiTypes,
  McpDeploymentStatusEntry,
} from "@archestra/shared";

/**
 * The one rule for "which MCP servers need attention", shared by the sidebar
 * count, the registry's Needs-attention tab, the Status filter, the table
 * Status column and the cards. Everything is derived from data the registry
 * already loads: installed server rows (installation and OAuth state, reinstall
 * flags), the live K8s deployment statuses (when the caller has them), and the
 * catalog item's own flags. Kept pure so every surface counts the same way.
 *
 * Vocabulary (also the words shown to users):
 *   down       Failed to start · Not running · Needs re-authentication
 *   attention  Reinstall required · Awaiting image approval · Stuck starting
 *   progress   Starting (installing / pod starting / waking) — never counted
 */
export type McpServerIssueKind =
  | "failed-to-start"
  | "not-running"
  | "needs-reauth"
  | "reinstall-required"
  | "awaiting-approval"
  | "stuck-starting"
  | "starting";

export type McpServerIssueSeverity = "down" | "attention" | "progress";

/** Who can clear the issue from where they are. */
export type McpServerIssueAudience =
  /** The viewer can act on it (re-authenticate, reinstall, approve, fix). */
  | "you"
  /** Somebody else's connection or a step only another role can take. */
  | "others"
  /** Nobody needs to act; the system is working on it. */
  | "system";

export interface McpServerIssue {
  kind: McpServerIssueKind;
  severity: McpServerIssueSeverity;
  audience: McpServerIssueAudience;
  catalogId: string;
  /** The install this issue is about; absent for catalog-scope issues. */
  serverId?: string;
  /** Free-text cause (an error message), if the source has one. */
  detail: string | null;
  /** When the issue started, if the source records it. */
  since: string | null;
}

export type CatalogItemForIssues = Pick<
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
  | "id"
  | "serverType"
  | "multitenant"
  | "catalogReinstallRequired"
  | "imageApprovalRequired"
>;

export type InstalledServerForIssues = Pick<
  archestraApiTypes.GetMcpServersResponses["200"][number],
  | "id"
  | "catalogId"
  | "ownerId"
  | "teamId"
  | "scope"
  | "localInstallationStatus"
  | "localInstallationError"
  | "oauthRefreshError"
  | "oauthRefreshErrorMessage"
  | "oauthRefreshErrorDescription"
  | "oauthRefreshFailedAt"
  | "reinstallRequired"
  | "reinstallReason"
>;

/** What the viewer may do — resolved by the caller from session + permissions. */
export interface IssueViewer {
  userId: string | null;
  canReauthenticate: (server: InstalledServerForIssues) => boolean;
  /** mcpServerInstallation:admin — may reinstall any install, restart pods, approve images. */
  canManageInstalls: boolean;
  /** mcpRegistry:update — may recreate a multi-tenant catalog's shared pod. */
  canEditCatalog: boolean;
}

export interface McpServerIssueKindMeta {
  kind: McpServerIssueKind;
  severity: McpServerIssueSeverity;
  /** Status string shown on pills, rows and cards. */
  label: string;
  /** Sentence fragment for the summary: "N <phrase>". */
  phrase: (count: number) => string;
}

// Ordered by severity, then by how urgently the operator has to act — this
// is the order pills, filter options and summary fragments render in.
export const MCP_SERVER_ISSUE_KINDS: McpServerIssueKindMeta[] = [
  {
    kind: "failed-to-start",
    severity: "down",
    label: "Failed to start",
    phrase: (n) => `${n} failed to start`,
  },
  {
    kind: "not-running",
    severity: "down",
    label: "Not running",
    phrase: (n) => `${n} not running`,
  },
  {
    kind: "needs-reauth",
    severity: "down",
    label: "Needs re-authentication",
    phrase: (n) =>
      n === 1 ? "1 needs re-authentication" : `${n} need re-authentication`,
  },
  {
    kind: "reinstall-required",
    severity: "attention",
    label: "Reinstall required",
    phrase: (n) => (n === 1 ? "1 needs a reinstall" : `${n} need a reinstall`),
  },
  {
    kind: "awaiting-approval",
    severity: "attention",
    label: "Awaiting image approval",
    phrase: (n) =>
      n === 1 ? "1 awaiting image approval" : `${n} awaiting image approval`,
  },
  {
    kind: "stuck-starting",
    severity: "attention",
    label: "Stuck starting",
    phrase: (n) => `${n} stuck starting`,
  },
  {
    kind: "starting",
    severity: "progress",
    label: "Starting",
    phrase: (n) => `${n} starting`,
  },
];

const KIND_META = new Map(MCP_SERVER_ISSUE_KINDS.map((m) => [m.kind, m]));
const KIND_ORDER = new Map(MCP_SERVER_ISSUE_KINDS.map((m, i) => [m.kind, i]));

export function getMcpServerIssueKindMeta(
  kind: McpServerIssueKind,
): McpServerIssueKindMeta {
  // Every kind is registered above; the fallback only satisfies the type.
  return KIND_META.get(kind) ?? MCP_SERVER_ISSUE_KINDS[0];
}

/**
 * Per-catalog-item issues, keyed by catalog id; items with nothing to report
 * are absent. Issues within an item are sorted by kind order.
 */
export function computeMcpServerIssues({
  items,
  servers,
  deploymentStatuses,
  viewer,
}: {
  items: CatalogItemForIssues[];
  servers: InstalledServerForIssues[];
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  viewer: IssueViewer;
}): Map<string, McpServerIssue[]> {
  const serversByCatalog = new Map<string, InstalledServerForIssues[]>();
  for (const s of servers) {
    if (!s.catalogId) continue;
    const list = serversByCatalog.get(s.catalogId);
    if (list) list.push(s);
    else serversByCatalog.set(s.catalogId, [s]);
  }

  const result = new Map<string, McpServerIssue[]>();
  for (const item of items) {
    const issues = computeItemIssues({
      item,
      servers: serversByCatalog.get(item.id) ?? [],
      deploymentStatuses,
      viewer,
    });
    if (issues.length > 0) result.set(item.id, issues);
  }
  return result;
}

// ===== Summaries =====

export interface McpServerIssueSummary {
  /** Catalog items with at least one issue the viewer can act on. */
  actionableServerCount: number;
  /** Actionable issue count per kind, in kind order; zero kinds omitted. */
  actionableByKind: { kind: McpServerIssueKind; count: number }[];
  /** Catalog items whose only issues belong to somebody else. */
  othersServerCount: number;
  /** Catalog items with something in progress (and nothing else). */
  inProgressServerCount: number;
  /** Highest severity among the viewer's actionable issues. */
  severity: Exclude<McpServerIssueSeverity, "progress"> | null;
}

export function summarizeMcpServerIssues(
  issuesByCatalog: Map<string, McpServerIssue[]>,
): McpServerIssueSummary {
  const counts = new Map<McpServerIssueKind, number>();
  let actionable = 0;
  let others = 0;
  let inProgress = 0;
  for (const issues of issuesByCatalog.values()) {
    const bucket = bucketOf(issues);
    if (bucket === "you") {
      actionable++;
      for (const issue of issues) {
        if (issue.audience !== "you") continue;
        counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
      }
    } else if (bucket === "others") others++;
    else inProgress++;
  }
  const actionableByKind = MCP_SERVER_ISSUE_KINDS.filter((m) =>
    counts.has(m.kind),
  ).map((m) => ({ kind: m.kind, count: counts.get(m.kind) ?? 0 }));
  const severity = actionableByKind.some(
    (b) => getMcpServerIssueKindMeta(b.kind).severity === "down",
  )
    ? "down"
    : actionableByKind.length > 0
      ? "attention"
      : null;
  return {
    actionableServerCount: actionable,
    actionableByKind,
    othersServerCount: others,
    inProgressServerCount: inProgress,
    severity,
  };
}

/**
 * Which section of the Needs-attention list an item belongs to: "you" if any
 * of its issues is the viewer's to fix, else "others" if somebody else has to,
 * else "system".
 */
export function bucketOf(issues: McpServerIssue[]): McpServerIssueAudience {
  if (issues.some((i) => i.audience === "you")) return "you";
  if (issues.some((i) => i.audience === "others")) return "others";
  return "system";
}

/** "2 failed to start · 1 needs re-authentication". */
export function formatIssueBreakdown(summary: McpServerIssueSummary): string {
  return summary.actionableByKind
    .map(({ kind, count }) => getMcpServerIssueKindMeta(kind).phrase(count))
    .join(" · ");
}

/**
 * What the status means and what clears it, in the words a row or banner
 * shows under the status pill. `what` states the condition; `fix` names the
 * concrete next step — including which part of the configuration to look at,
 * so an admin doesn't have to guess from a raw runtime message.
 */
export function describeMcpServerIssue(issue: McpServerIssue): {
  what: string;
  fix: string;
} {
  switch (issue.kind) {
    case "failed-to-start":
      return {
        what: "The server exited before it answered the first request.",
        fix: "Check the logs for the error, then correct the command, arguments or environment variables in the configuration.",
      };
    case "not-running":
      return {
        what: "The server keeps crashing after a successful install.",
        fix: "Check the logs; if the configuration is right, restart the server from its page.",
      };
    case "stuck-starting":
      return {
        what: "Kubernetes cannot pull the container image, so the server never starts.",
        fix: "Check the image name, tag and registry access in the configuration.",
      };
    case "needs-reauth":
      return {
        what: "The provider rejected the stored token, so this connection's tools fail.",
        fix: "Sign in to the provider again to restore the connection.",
      };
    case "reinstall-required":
      return {
        what:
          issue.detail ?? "The configuration changed after this was installed.",
        fix: "Reinstall to apply it — tool assignments and policies are kept.",
      };
    case "awaiting-approval":
      return {
        what: "The Docker image is not from a trusted registry, so nobody can install this server yet.",
        fix: "Review the image and approve it in the server's configuration.",
      };
    case "starting":
      return {
        what: "The server is starting.",
        fix: "",
      };
    default:
      return { what: issue.detail ?? "", fix: "" };
  }
}

/** True when the item has an issue somebody (viewer or others) must act on. */
export function needsAttention(issues: McpServerIssue[] | undefined): boolean {
  return !!issues?.some((i) => i.severity !== "progress");
}

/**
 * A runtime / install error for a surface that already names the server: the
 * "Deployment mcp-<name>-<hash> failed: " prefix and the kubelet's
 * "container=… pod=…(uid)" identifiers only push the cause off screen, so
 * they are dropped. The Logs tab still shows the raw message.
 */
export function tidyMcpServerErrorText(
  text: string | null | undefined,
): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/^Deployment \S+ failed:\s*/i, "")
    .replace(/\s+(?:container|pod)=\S+/g, "")
    .trim();
}

// ===== Internal pieces =====

function compareKinds(a: McpServerIssueKind, b: McpServerIssueKind): number {
  return (KIND_ORDER.get(a) ?? 0) - (KIND_ORDER.get(b) ?? 0);
}

function computeItemIssues({
  item,
  servers,
  deploymentStatuses,
  viewer,
}: {
  item: CatalogItemForIssues;
  servers: InstalledServerForIssues[];
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  viewer: IssueViewer;
}): McpServerIssue[] {
  const issues: McpServerIssue[] = [];
  const isLocal = item.serverType === "local";
  const canFixInstall = (s: InstalledServerForIssues) =>
    viewer.canManageInstalls || s.ownerId === viewer.userId;
  const push = (
    issue: Omit<McpServerIssue, "severity" | "catalogId" | "detail" | "since"> &
      Partial<Pick<McpServerIssue, "detail" | "since">>,
  ) =>
    issues.push({
      severity: getMcpServerIssueKindMeta(issue.kind).severity,
      catalogId: item.id,
      detail: null,
      since: null,
      ...issue,
    });

  // Failed installs. Multi-tenant catalogs alias one pod across many
  // mcp_server rows, so every sibling reports the same error — collapse to
  // one per catalog. Single-tenant installs own their pods; dedupe by pod,
  // falling back to the row itself.
  const failedInstallServerIds = new Set<string>();
  if (isLocal) {
    const seen = new Set<string>();
    for (const s of servers) {
      if (s.localInstallationStatus !== "error") continue;
      failedInstallServerIds.add(s.id);
      const key = item.multitenant
        ? `catalog:${item.id}`
        : (deploymentStatuses[s.id]?.podName ?? s.id);
      if (seen.has(key)) continue;
      seen.add(key);
      push({
        kind: "failed-to-start",
        audience: canFixInstall(s) ? "you" : "others",
        serverId: s.id,
        detail: tidyMcpServerErrorText(s.localInstallationError),
      });
    }
  }

  // Runtime state after a successful install: a pod that failed (crash loop,
  // config error), a pod the kubelet keeps retrying to pull the image for
  // ("pending" with an error), and plain starting/waking. Dedupe by
  // deployment identity, so multi-tenant siblings count as one pod.
  if (isLocal) {
    const seenDeployments = new Set<string>();
    for (const s of servers) {
      if (failedInstallServerIds.has(s.id)) continue;
      const entry = deploymentStatuses[s.id];
      const installing =
        s.localInstallationStatus === "pending" ||
        s.localInstallationStatus === "discovering-tools";
      let kind: McpServerIssueKind | null = null;
      if (entry?.state === "failed") {
        // A pod that failed while the install is still pending will fail the
        // install too — say so now rather than "Starting" (mirrors the card).
        kind = installing ? "failed-to-start" : "not-running";
      } else if (installing) {
        kind = "starting";
      } else if (entry?.state === "pending" && entry.error) {
        kind = "stuck-starting";
      } else if (entry?.state === "pending" || entry?.state === "waking") {
        kind = "starting";
      }
      if (!kind) continue;
      const key = entry?.deploymentName ?? entry?.podName ?? s.id;
      if (seenDeployments.has(key)) continue;
      seenDeployments.add(key);
      push({
        kind,
        audience:
          kind === "starting" ? "system" : canFixInstall(s) ? "you" : "others",
        serverId: s.id,
        detail: entry ? formatRuntimeDetail(entry) : null,
      });
    }
  }

  // OAuth refresh failures are per connection: each has to be
  // re-authenticated by whoever owns it, so no dedup.
  for (const s of servers) {
    if (!s.oauthRefreshError) continue;
    push({
      kind: "needs-reauth",
      audience: viewer.canReauthenticate(s) ? "you" : "others",
      serverId: s.id,
      detail:
        s.oauthRefreshErrorDescription ?? s.oauthRefreshErrorMessage ?? null,
      since: s.oauthRefreshFailedAt ?? null,
    });
  }

  // Reinstall: a multi-tenant local catalog whose execution config changed
  // needs its shared pod recreated once (catalog scope). Otherwise, each
  // install flagged after a config edit needs its own reinstall.
  if (isLocal && item.multitenant && item.catalogReinstallRequired) {
    push({
      kind: "reinstall-required",
      audience: viewer.canEditCatalog ? "you" : "others",
      detail: "Server configuration changed since the shared pod was created",
    });
  } else {
    for (const s of servers) {
      if (!s.reinstallRequired) continue;
      push({
        kind: "reinstall-required",
        audience: canFixInstall(s) ? "you" : "others",
        serverId: s.id,
        detail: reinstallReasonText(s.reinstallReason),
      });
    }
  }

  if (item.imageApprovalRequired) {
    push({
      kind: "awaiting-approval",
      // Non-approvers can't do anything about it; to them it is "in progress".
      audience: viewer.canManageInstalls ? "you" : "system",
      detail: "Docker image is not from a trusted registry",
    });
  }

  return issues.sort((a, b) => compareKinds(a.kind, b.kind));
}

function formatRuntimeDetail(entry: McpDeploymentStatusEntry): string {
  const base = tidyMcpServerErrorText(entry.error) ?? entry.message;
  return entry.restartCount && entry.restartCount > 0
    ? `${base} · ${entry.restartCount} restart${entry.restartCount === 1 ? "" : "s"}`
    : base;
}

function reinstallReasonText(
  reason: InstalledServerForIssues["reinstallReason"],
): string {
  switch (reason) {
    case "new-input":
      return "Configuration asks for new values since this was installed";
    case "restart":
      return "Configuration changed since this was installed";
    default:
      return "Configuration changed since this was installed";
  }
}
