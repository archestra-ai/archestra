import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";

/**
 * The one rule for "which MCP servers need attention", shared by the sidebar
 * count, the registry list's audience facets, the table Status column and the
 * cards. Everything is derived from data the registry already loads: installed
 * server rows (installation and OAuth state, reinstall flags, the viewer's own
 * alert mutes), the live K8s deployment statuses (when the caller has them),
 * and the catalog item's own flags. Kept pure so every surface counts the same
 * way.
 *
 * `attentionCatalogIds` is the single predicate behind every number the
 * registry prints. Its `audience` argument is a whole item's bucket
 * (`bucketOf`), never an individual `issue.audience`: an item carrying one of
 * your faults and one of somebody else's is yours alone, so it appears once
 * and is counted once. The built-in Archestra catalog entry is excluded inside
 * the predicate, because the list excludes it too, and a badge counting rows
 * the list refuses to render sends people looking for something that is not
 * there.
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
  | "alertMutes"
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

/**
 * Which audience an item belongs to: "you" if any of its issues is the
 * viewer's to fix, else "others" if somebody else has to, else "system".
 * Muted issues are excluded by the caller, not here — the server page shows
 * the true bucket whether or not the viewer silenced the alert.
 */
export function bucketOf(issues: McpServerIssue[]): McpServerIssueAudience {
  if (issues.some((i) => i.audience === "you")) return "you";
  if (issues.some((i) => i.audience === "others")) return "others";
  return "system";
}

/** The issues one facet is about, in the order the kinds are declared. */
export function facetIssues(
  issues: McpServerIssue[],
  facet: McpServerAttentionFacet,
): McpServerIssue[] {
  if (facet === "muted") return issues.filter((i) => i.muted);
  const live = issues.filter((i) => !i.muted);
  if (facet === "you") return live.filter((i) => i.audience === "you");
  // Everything left that somebody has to act on. Audience "system" is included
  // deliberately: see `audienceFacetOf`.
  return live.filter((i) => i.audience !== "you" && i.severity !== "progress");
}

/**
 * Whether the viewer may repair one install: reinstall it, restart its pod or
 * cancel it. An installs admin may act on anybody's, everybody else only on
 * their own.
 *
 * Exported because the card and the table decide whether to render the button
 * this module's "Reinstall required" issue tells the user to press. While the
 * two rules differed, an admin who did not own the install was told to
 * reinstall and found no button anywhere.
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
 * concrete next step — including which part of the configuration to look at,
 * so an admin doesn't have to guess from a raw runtime message. `whoActs`
 * names who can take that step, for the rows where the viewer cannot: waiting
 * on a colleague is not a permission failure, and a row that just hides its
 * button reads like one.
 */
export function describeMcpServerIssue(issue: McpServerIssue): {
  what: string;
  fix: string;
  whoActs: string;
} {
  switch (issue.kind) {
    case "failed-to-start":
      return {
        what: "The server exited before it answered the first request.",
        fix: "Check the logs for the error, then correct the command, arguments or environment variables in the configuration.",
        whoActs: INSTALL_OWNER_OR_ADMIN_ACTS,
      };
    case "not-running":
      return {
        what: "The server keeps crashing after a successful install.",
        fix: "Check the logs; if the configuration is right, restart the server from its page.",
        whoActs: INSTALL_OWNER_OR_ADMIN_ACTS,
      };
    case "stuck-starting":
      return {
        what: "Kubernetes cannot pull the container image, so the server never starts.",
        fix: "Check the image name, tag and registry access in the configuration.",
        whoActs: INSTALL_OWNER_OR_ADMIN_ACTS,
      };
    case "needs-reauth":
      return {
        what: "The provider rejected the stored token, so this connection's tools fail.",
        fix: "Sign in to the provider again to restore the connection.",
        whoActs:
          "Only the person who owns this connection can sign in to the provider again.",
      };
    case "reinstall-required":
      return {
        what:
          issue.detail ?? "The configuration changed after this was installed.",
        fix: "Reinstall to apply it — tool assignments and policies are kept.",
        // A catalog-scope reinstall recreates the pod everyone shares, which
        // only somebody who may edit the registry entry can do.
        whoActs: issue.serverId
          ? INSTALL_OWNER_OR_ADMIN_ACTS
          : "An admin who can edit this registry entry has to recreate the shared server.",
      };
    case "awaiting-approval":
      return {
        what: "The Docker image is not from a trusted registry, so nobody can install this server yet.",
        fix: "Review the image and approve it in the server's configuration.",
        whoActs: "An MCP installations admin has to approve the image.",
      };
    case "starting":
      return {
        what: "The server is starting.",
        fix: "",
        whoActs: "",
      };
    default:
      return { what: issue.detail ?? "", fix: "", whoActs: "" };
  }
}

const INSTALL_OWNER_OR_ADMIN_ACTS =
  "Whoever installed this connection, or an MCP installations admin, can fix it.";

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

/**
 * The audience facet an item lands in, or null when it has nothing outstanding
 * left. Muted issues are dropped first: a muted item leaves both audience
 * counts and is reached through the Muted facet instead.
 *
 * The "others" case is decided by severity rather than by audience, so nothing
 * broken can fall out of every facet. An image awaiting approval is audience
 * "system" to somebody who cannot approve it — nobody they can name is acting
 * on it — but it is still stopping installs, and hiding it entirely would make
 * the facets add up to less than the trouble on the page.
 */
function audienceFacetOf(
  issues: McpServerIssue[],
): Exclude<McpServerAttentionFacet, "muted"> | null {
  const live = issues.filter((issue) => !issue.muted);
  if (bucketOf(live) === "you") return "you";
  return needsAttention(live) ? "others" : null;
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
    issue: Omit<
      McpServerIssue,
      "severity" | "catalogId" | "detail" | "since" | "muted" | "mutedReason"
    > &
      Partial<
        Pick<McpServerIssue, "detail" | "since" | "muted" | "mutedReason">
      >,
  ) =>
    issues.push({
      severity: getMcpServerIssueKindMeta(issue.kind).severity,
      catalogId: item.id,
      detail: null,
      since: null,
      // Only `needs-reauth` is mutable, so everything else is live by
      // construction rather than by a per-kind check at each call site.
      muted: false,
      mutedReason: null,
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
        audience: viewerCanFix(s) ? "you" : "others",
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
          kind === "starting" ? "system" : viewerCanFix(s) ? "you" : "others",
        serverId: s.id,
        detail: entry ? formatRuntimeDetail(entry) : null,
      });
    }
  }

  // OAuth refresh failures are per connection: each has to be
  // re-authenticated by whoever owns it, so no dedup.
  for (const s of servers) {
    if (!s.oauthRefreshError) continue;
    // The API returns only the caller's own mutes, and only while they still
    // apply to the failure being reported, so presence is the whole answer.
    const mute = s.alertMutes.find((m) => m.issueKind === "needs-reauth");
    push({
      kind: "needs-reauth",
      audience: viewer.canReauthenticate(s) ? "you" : "others",
      serverId: s.id,
      detail:
        s.oauthRefreshErrorDescription ?? s.oauthRefreshErrorMessage ?? null,
      since: s.oauthRefreshFailedAt ?? null,
      muted: !!mute,
      mutedReason: mute?.reason ?? null,
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
        audience: viewerCanFix(s) ? "you" : "others",
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
