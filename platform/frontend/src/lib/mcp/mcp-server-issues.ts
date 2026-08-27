import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  classifyMcpRuntimeAlert,
  createMcpServerAlertFingerprint,
  type McpDeploymentStatusEntry,
  mcpRuntimeAlertSource,
} from "@archestra/shared";

/**
 * The one rule for "which MCP servers need attention", shared by the sidebar
 * count, the registry list's audience facets, the table Status column and the
 * cards. There is no state mapping to maintain: a server is flagged exactly
 * when an error payload says it cannot operate, and the payload itself says
 * why. Three sources, three statuses:
 *
 *   localInstallationError   Failed to start          fix the configuration
 *   deployment failed/gone   Not running              logs, then restart
 *   oauthRefreshError        Needs re-authentication  sign in again
 *
 * Everything else is normal operation or transient progress and never raises
 * an alert: pending installs, image approval, reinstall hints, a pod that is
 * merely starting. A healthy running pod also clears the flag regardless of
 * what stale state the server row carries — the running pod is proof the
 * installation works.
 *
 * `attentionCatalogIds` is the single predicate behind every number the
 * registry prints. Its `audience` argument is a whole item's bucket
 * (`bucketOf`), never an individual `issue.audience`: an item carrying one of
 * your faults and one of somebody else's is yours alone, so it appears once
 * and is counted once. The built-in Archestra catalog entry is excluded inside
 * the predicate, because the list excludes it too, and a badge counting rows
 * the list refuses to render sends people looking for something that is not
 * there.
 */
export type McpServerIssueKind =
  | "failed-to-start"
  | "not-running"
  | "needs-reauth";

/** Who can clear the issue from where they are. */
export type McpServerIssueAudience =
  /** The viewer can act on it (re-authenticate, fix the configuration). */
  | "you"
  /** Somebody else's connection; only they or an admin can act. */
  | "others";

export interface McpServerIssue {
  kind: McpServerIssueKind;
  audience: McpServerIssueAudience;
  catalogId: string;
  /** The install this issue is about; absent for catalog-scope issues. */
  serverId?: string;
  /** The error text that raised the issue, tidied for display. */
  detail: string | null;
  /** When the issue started, if the source records it. */
  since: string | null;
  /** Stable for this failure episode; changes when the underlying state does. */
  fingerprint: string;
  /**
   * The viewer silenced this issue for themselves. It leaves every count and
   * still renders under the Muted facet, so the state stays visible.
   */
  muted: boolean;
  /**
   * The note the viewer gave when they muted it, so the surfaces that show the
   * mute can show why it is muted. Null whenever `muted` is false, and also
   * whenever the mute is somebody else's: the API returns only the caller's
   * own mutes, so nobody ever reads a colleague's note here.
   */
  mutedReason: string | null;
}

type AlertMuteForIssues =
  archestraApiTypes.GetMcpServersResponses["200"][number]["alertMutes"][number];

export type CatalogItemForIssues = Pick<
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
  "id" | "serverType" | "multitenant" | "alertMutes"
>;

export type InstalledServerForIssues = Pick<
  archestraApiTypes.GetMcpServersResponses["200"][number],
  | "id"
  | "catalogId"
  | "ownerId"
  | "localInstallationStatus"
  | "localInstallationError"
  | "oauthRefreshError"
  | "oauthRefreshErrorMessage"
  | "oauthRefreshErrorDescription"
  | "oauthRefreshFailedAt"
  | "updatedAt"
  | "alertMutes"
>;

/** What the viewer may do — resolved by the caller from session + permissions. */
export interface IssueViewer {
  userId: string | null;
  canReauthenticate: (server: InstalledServerForIssues) => boolean;
  /** mcpServerInstallation:admin — may act on any install, not just their own. */
  canManageInstalls: boolean;
}

export interface McpServerIssueKindMeta {
  kind: McpServerIssueKind;
  /** Status string shown on pills, rows and cards. */
  label: string;
}

// Ordered by how urgently the operator has to act — this is the order pills,
// filter options and rows render in.
export const MCP_SERVER_ISSUE_KINDS: McpServerIssueKindMeta[] = [
  { kind: "failed-to-start", label: "Failed to start" },
  { kind: "not-running", label: "Not running" },
  { kind: "needs-reauth", label: "Needs re-authentication" },
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

// ===== Facets =====

/**
 * The facets the registry list can be narrowed to. "you" and "others" are
 * audience facets and never overlap, so an item belongs to exactly one of
 * them. "muted" cuts across both: it holds whatever the viewer has silenced
 * for themselves, which is precisely what the other two leave out.
 */
export type McpServerAttentionFacet = "you" | "others" | "muted";

/**
 * The catalog ids in one facet, and the only place membership is decided. The
 * sidebar badge, the facet counts in the list toolbar and the rows the list
 * renders all call this, so the three cannot drift apart.
 *
 * `audience` selects on the item's bucket (`bucketOf`), not on an individual
 * `issue.audience`: an item with one of your faults and one of somebody else's
 * is yours only, listed once and counted once.
 */
export function attentionCatalogIds(
  issuesByCatalog: Map<string, McpServerIssue[]>,
  { audience }: { audience: McpServerAttentionFacet },
): string[] {
  const ids: string[] = [];
  for (const [catalogId, issues] of issuesByCatalog) {
    // The built-in Archestra entry cannot be installed, reinstalled or
    // re-authenticated, and the list never shows it.
    if (catalogId === ARCHESTRA_MCP_CATALOG_ID) continue;
    const matches =
      audience === "muted"
        ? issues.some((issue) => issue.muted)
        : audienceFacetOf(issues) === audience;
    if (matches) ids.push(catalogId);
  }
  return ids;
}

export function attentionSortRank(
  issues: McpServerIssue[] | undefined,
): number {
  const live = (issues ?? []).filter((issue) => !issue.muted);
  if (live.some((issue) => issue.audience === "you")) return 0;
  if (live.length > 0) return 1;
  return 2;
}

/**
 * Which audience an item belongs to: "you" if any of its issues is the
 * viewer's to fix, else "others". Muted issues are excluded by the caller,
 * not here — the server page shows the true bucket whether or not the viewer
 * silenced the alert.
 */
export function bucketOf(issues: McpServerIssue[]): McpServerIssueAudience {
  return issues.some((i) => i.audience === "you") ? "you" : "others";
}

/** The issues one facet is about, in the order the kinds are declared. */
export function facetIssues(
  issues: McpServerIssue[],
  facet: McpServerAttentionFacet,
): McpServerIssue[] {
  if (facet === "muted") return issues.filter((i) => i.muted);
  const live = issues.filter((i) => !i.muted);
  return live.filter(
    (i) => i.audience === (facet === "you" ? "you" : "others"),
  );
}

/**
 * Whether the viewer may repair one install: fix its configuration, restart
 * its pod or remove it. An installs admin may act on anybody's, everybody
 * else only on their own.
 */
export function canFixInstall({
  server,
  viewer,
}: {
  server: Pick<InstalledServerForIssues, "ownerId">;
  viewer: Pick<IssueViewer, "userId" | "canManageInstalls">;
}): boolean {
  return viewer.canManageInstalls || server.ownerId === viewer.userId;
}

/**
 * What the status means and what clears it, in the words a row or banner
 * shows under the status pill. `what` states the condition; `fix` names the
 * concrete next step. `whoActs` names the role that can take that step when
 * the viewer cannot.
 */
export function describeMcpServerIssue(issue: McpServerIssue): {
  what: string;
  fix: string;
  whoActs: string;
} {
  switch (issue.kind) {
    case "failed-to-start":
      return {
        what: "The server could not start.",
        fix: "Check the logs for the error, then correct the image, command, arguments or environment variables in the configuration.",
        whoActs: INSTALL_OWNER_OR_ADMIN_ACTS,
      };
    case "not-running":
      return {
        what: "The server keeps crashing after a successful install.",
        fix: "Check the logs; if the configuration is right, restart the server from its page.",
        whoActs: INSTALL_OWNER_OR_ADMIN_ACTS,
      };
    case "needs-reauth":
      return {
        what: "The provider rejected the stored token, so this connection's tools fail.",
        fix: "Sign in to the provider again to restore the connection.",
        whoActs:
          "Only the person who owns this connection can sign in to the provider again.",
      };
    default:
      return { what: issue.detail ?? "", fix: "", whoActs: "" };
  }
}

const INSTALL_OWNER_OR_ADMIN_ACTS =
  "Whoever installed this connection, or an MCP installations admin, can fix it.";

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

/**
 * The audience facet an item lands in, or null when it has nothing
 * outstanding left. Muted issues are dropped first: a muted item leaves both
 * audience counts and is reached through the Muted facet instead.
 */
function audienceFacetOf(
  issues: McpServerIssue[],
): Exclude<McpServerAttentionFacet, "muted"> | null {
  const live = issues.filter((issue) => !issue.muted);
  if (live.length === 0) return null;
  return bucketOf(live);
}

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
  const viewerCanFix = (s: InstalledServerForIssues) =>
    canFixInstall({ server: s, viewer });
  const push = (
    input: Omit<
      McpServerIssue,
      "catalogId" | "detail" | "since" | "fingerprint" | "muted" | "mutedReason"
    > &
      Partial<
        Pick<McpServerIssue, "detail" | "since" | "muted" | "mutedReason">
      > & { fingerprintSource?: string | null },
  ) => {
    const { fingerprintSource, ...issue } = input;
    const fingerprint = createMcpServerAlertFingerprint({
      kind: issue.kind,
      catalogId: item.id,
      serverId: issue.serverId,
      source: fingerprintSource ?? issue.since ?? issue.detail ?? "current",
    });
    const dismissals = [
      ...(item.alertMutes ?? []),
      ...(issue.serverId
        ? (servers.find((server) => server.id === issue.serverId)?.alertMutes ??
          [])
        : []),
    ] as AlertMuteForIssues[];
    const dismissal = dismissals.find(
      (candidate) =>
        candidate.issueKind === issue.kind &&
        candidate.mcpServerId === (issue.serverId ?? null) &&
        candidate.issueFingerprint === fingerprint,
    );
    issues.push({
      catalogId: item.id,
      detail: null,
      since: null,
      fingerprint,
      muted: !!dismissal,
      mutedReason: dismissal?.reason ?? null,
      ...issue,
    });
  };

  // Local servers: the row's installation error and the runtime's deployment
  // state are the error payloads. Multi-tenant rows alias one pod, so
  // collapse siblings by deployment identity.
  if (isLocal) {
    const sharedInstallFailureSource = item.multitenant
      ? mcpRuntimeAlertSource({
          serverId: `catalog:${item.id}`,
          deploymentName: item.id,
          state: "failed",
          error: JSON.stringify(
            servers
              .filter((server) => server.localInstallationStatus === "error")
              .map((server) => server.localInstallationError ?? "")
              .sort(),
          ),
        })
      : null;
    const seenDeployments = new Set<string>();
    for (const s of servers) {
      const entry = deploymentStatuses[s.id];
      // A healthy or on-demand pod proves the current installation works,
      // whatever stale state the row carries.
      if (entry?.state === "running" || entry?.state === "hibernated") {
        continue;
      }
      const installFailed = s.localInstallationStatus === "error";
      const kind = classifyMcpRuntimeAlert({
        runtimeState: entry?.state,
        runtimeError: entry?.error,
        installationStatus: s.localInstallationStatus,
      });
      if (!kind) continue;
      const key =
        entry?.deploymentName ??
        entry?.podName ??
        (item.multitenant ? `catalog:${item.id}` : s.id);
      if (seenDeployments.has(key)) continue;
      seenDeployments.add(key);
      const installError = tidyMcpServerErrorText(s.localInstallationError);
      push({
        kind,
        audience: viewerCanFix(s) ? "you" : "others",
        serverId: item.multitenant ? undefined : s.id,
        detail:
          kind === "failed-to-start" && installError
            ? installError
            : entry
              ? formatRuntimeDetail(entry)
              : null,
        fingerprintSource:
          kind === "failed-to-start" && installFailed
            ? item.multitenant
              ? sharedInstallFailureSource
              : String(s.updatedAt)
            : mcpRuntimeAlertSource({
                serverId: item.multitenant ? `catalog:${item.id}` : s.id,
                deploymentName: entry?.deploymentName,
                podName: entry?.podName,
                state: entry?.state ?? kind,
                error: entry?.error ?? null,
                restartCount: entry?.restartCount ?? 0,
              }),
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
      fingerprintSource: s.oauthRefreshFailedAt,
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
