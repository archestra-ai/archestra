"use client";

import { E2eTestId } from "@archestra/shared";
import {
  Bell,
  BellOff,
  FileSearch,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { typeRole } from "@/lib/design/type-scale";
import { useRestoreMcpServerAlerts } from "@/lib/mcp/mcp-server.query";
import {
  bucketOf,
  canFixInstall,
  describeMcpServerIssue,
  facetIssues,
  type McpServerAttentionFacet,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import {
  DismissAlertDialog,
  type DismissAlertTarget,
} from "./dismiss-alert-dialog";
import { mcpServerAlertTarget } from "./mcp-server-alert-target";
import { describeMcpIssueActionOwners } from "./mcp-server-attention-owner";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
import { McpServerIssueBadge } from "./mcp-server-issue-badge";
import { humanizeOAuthErrorCode } from "./oauth-reauth-detail";
import {
  UninstallServerDialog,
  type UninstallServerInstall,
} from "./uninstall-server-dialog";

/**
 * One server's outstanding issues, shared by three contexts:
 *
 * - `panel` (the server's Overview): the page has no other context, so the
 *   panel also discloses the primary raw runtime message.
 * - `actions`: issue-specific remediation and queue actions for the registry
 *   table's Actions cell.
 * - `details`: the registry table's expanded sub-row diagnosis. It is strictly
 *   informational; every action stays in the table's Actions cell.
 * - `primary-action`: only the highest-priority remediation for a compact card.
 *
 * Every issue kind in the viewer's own bucket is explained, not just the worst
 * one: a server whose pod crashed and whose token was rejected has two
 * problems, and naming one of them sends the user back a second time for the
 * other.
 */
type Action = {
  actionId: string;
  context?: string;
  contextId?: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  testId?: string;
  variant?: TableRowAction["variant"];
};

type ActionSet = {
  primary?: Action;
  secondary?: Action;
};

export function McpServerIssueNotice({
  item,
  issues,
  servers,
  facet = null,
  hideName = false,
  variant = "panel",
  panelActions = "all",
  className,
  onTargetsCompleted,
}: {
  item: CatalogItem;
  issues: McpServerIssue[];
  servers: InstalledServer[];
  /**
   * The facet the list is narrowed to, when it is narrowed to one. The row
   * explains that facet's issues, so a row reached under Dismissed shows what
   * the viewer dismissed rather than a live issue from another facet.
   */
  facet?: McpServerAttentionFacet | null;
  /** On the server's own page the name is the page title already. */
  hideName?: boolean;
  variant?: "panel" | "actions" | "details" | "primary-action";
  /** Detail pages already expose remediation in their header and sections. */
  panelActions?: "all" | "dismiss-only";
  className?: string;
  onTargetsCompleted?: (targets: readonly DismissAlertTarget[]) => void;
}) {
  const router = useRouter();
  const [showDetail, setShowDetail] = useState(false);
  const detailId = useId();
  const [dismissOpen, setDismissOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const { data: session } = useSession();
  const { data: canManageInstalls } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: canEditCatalog } = useHasPermissions({
    mcpRegistry: ["update"],
  });
  const restoreMutation = useRestoreMcpServerAlerts();

  const liveIssues = issues.filter((i) => !i.muted);
  const viewerBucket = bucketOf(liveIssues);
  // What this row is about. Under a facet it is that facet's issues, so the
  // row shows the state the reader narrowed the list to. Off a facet (the
  // server's own page) it is the viewer's own bucket, falling back to the
  // muted issues once every live one has been silenced.
  const relevant = facet
    ? facetIssues(issues, facet)
    : liveIssues.length > 0
      ? viewerBucket === "you"
        ? facetIssues(issues, "you")
        : liveIssues
      : facetIssues(issues, "muted");
  // One pill and one paragraph per kind: three connections failing OAuth are
  // one thing to read, not three.
  const explained = distinctByKind(relevant);
  // Issues are kind-ordered, so the first one the viewer can act on is also
  // the most severe one they can act on.
  const primary = explained.find((i) => i.audience === "you") ?? explained[0];

  // Every issue is tied to an affected installation when the backend can
  // identify one. A catalog-scope issue can still target the only installation
  // unambiguously; with several, send the reader to Manage connections.
  const affectedServerIds = new Set(
    relevant.flatMap((issue) => (issue.serverId ? [issue.serverId] : [])),
  );
  const directlyAffectedConnections = servers.filter((server) =>
    affectedServerIds.has(server.id),
  );
  const removableConnections =
    directlyAffectedConnections.length > 0
      ? directlyAffectedConnections
      : relevant.some((issue) => issue.audience === "you") &&
          servers.length === 1
        ? servers
        : [];
  const viewer = {
    userId: session?.user?.id ?? null,
    canManageInstalls: !!canManageInstalls,
  };
  const removableConnection =
    removableConnections.length === 1 &&
    canFixInstall({ server: removableConnections[0], viewer })
      ? removableConnections[0]
      : null;
  const queueTargets = relevant.map(
    (issue): { issue: McpServerIssue; target: DismissAlertTarget } => ({
      issue,
      target: mcpServerAlertTarget({ issue, item, servers }),
    }),
  );
  const dismissTargets = queueTargets
    .filter(({ issue }) => !issue.muted)
    .map(({ target }) => target);
  const restoreTargets = queueTargets
    .filter(({ issue }) => issue.muted)
    .map(({ target }) => target);

  const detailHref = (tab?: string, serverId?: string) => {
    const params = new URLSearchParams();
    if (tab) params.set("tab", tab);
    if (serverId) params.set("server", serverId);
    const qs = params.toString();
    return `/mcp/registry/${item.id}${qs ? `?${qs}` : ""}`;
  };
  const editHref = `/mcp/registry/${item.id}/edit?step=configuration`;

  // The raw runtime / provider message, for people who want the exact text.
  // OAuth codes get their human name.
  const rawDetailFor = (issue: McpServerIssue) =>
    issue.kind === "needs-reauth" && issue.detail
      ? humanizeOAuthErrorCode(issue.detail)
      : (issue.detail ?? null);
  const disclosedDetail = primary ? rawDetailFor(primary) : null;

  // Keep one remediation visible and preserve every other issue-specific
  // action in overflow. Multi-status rows must not hide a valid fix merely
  // because another status sorts first.
  const actionsFor = (issue: McpServerIssue): ActionSet => {
    if (issue.audience !== "you" || issue.muted) return {};
    const connectionName = issue.serverId
      ? servers.find((server) => server.id === issue.serverId)?.name
      : undefined;
    const viewLogs: Action = {
      actionId: `view-logs:${issue.serverId ?? "catalog"}`,
      context: connectionName,
      contextId: issue.serverId ?? undefined,
      icon: <FileSearch className="h-4 w-4" />,
      label: "View logs",
      onClick: () => router.push(detailHref("logs", issue.serverId)),
      testId: `${E2eTestId.McpLogsViewButton}-${item.name}-issue`,
    };
    const editConfig: Action = {
      actionId: "edit-configuration",
      icon: <Pencil className="h-4 w-4" />,
      label: "Edit configuration",
      onClick: () => router.push(editHref),
      testId: `${E2eTestId.McpLogsEditConfigButton}-${item.name}-issue`,
    };
    switch (issue.kind) {
      case "needs-reauth":
        return {
          primary: {
            actionId: `reauthenticate:${issue.serverId ?? "catalog"}`,
            context: connectionName,
            contextId: issue.serverId ?? undefined,
            icon: <KeyRound className="h-4 w-4" />,
            label: "Re-authenticate",
            onClick: () =>
              router.push(detailHref("credentials", issue.serverId)),
          },
          secondary: canEditCatalog ? editConfig : undefined,
        };
      case "failed-to-start":
      case "not-running":
        return {
          primary: viewLogs,
          secondary: canEditCatalog ? editConfig : undefined,
        };
      default:
        return {};
    }
  };
  const actionSets = explained.map(actionsFor);
  const actions = actionSets.find((set) => set.primary || set.secondary) ?? {};
  const firstActionSetIndex = actionSets.indexOf(actions);
  const allRemediationActions = actionSets.flatMap((set) => [
    set.primary,
    set.secondary,
  ]);
  const repeatedRemediationLabels = repeatedActionLabels(allRemediationActions);
  const additionalRemediationActions = uniqueActions(
    actionSets
      .slice(firstActionSetIndex + 1)
      .flatMap((set) => [set.primary, set.secondary]),
    new Set([actions.primary?.actionId, actions.secondary?.actionId]),
  );

  const overflow: Action[] = [];
  if (removableConnection) {
    overflow.push({
      actionId: `remove-connection:${removableConnection.id}`,
      icon: <Trash2 className="h-4 w-4" />,
      label: "Remove this connection",
      variant: "destructive",
      onClick: () => setUninstallOpen(true),
    });
  } else if (removableConnections.length > 1) {
    overflow.push({
      actionId: "manage-connections",
      icon: <Users className="h-4 w-4" />,
      label: "Manage connections",
      onClick: () => router.push(detailHref("credentials")),
    });
  }

  const uninstallInstalls: UninstallServerInstall[] = removableConnection
    ? [
        {
          server: {
            id: removableConnection.id,
            name: removableConnection.name,
          },
          assignedAgents: removableConnection.assignedAgents ?? [],
        },
      ]
    : [];

  const panelPrimaryAction = actions.primary ? (
    <Button
      size="sm"
      data-testid={actions.primary.testId}
      onClick={actions.primary.onClick}
    >
      {actions.primary.label}
    </Button>
  ) : facet === "others" ? null : (
    <Button variant="outline" size="sm" asChild>
      <Link href={detailHref()}>Open</Link>
    </Button>
  );

  const queueActions = (
    <>
      {dismissTargets.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Dismiss alert for ${item.name}`}
          onClick={() => setDismissOpen(true)}
        >
          <BellOff className="h-4 w-4" />
          Dismiss
        </Button>
      )}
      {restoreTargets.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Restore alert for ${item.name}`}
          disabled={restoreMutation.isPending}
          onClick={() =>
            restoreMutation.mutate(
              {
                alerts: restoreTargets,
              },
              {
                onSuccess: (result) => onTargetsCompleted?.(result.succeeded),
              },
            )
          }
        >
          <Bell className="h-4 w-4" />
          Restore
        </Button>
      )}
    </>
  );
  const dismissOnlyAction = dismissTargets.length > 0 && (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Dismiss alert for ${item.name}`}
      onClick={() => setDismissOpen(true)}
    >
      <BellOff className="h-4 w-4" />
      Dismiss
    </Button>
  );

  // Compact icon buttons fit the complete row action set. Keep applicable
  // remediation visible instead of forcing discovery through a kebab menu.
  const rowActions: TableRowAction[] = contextualizeRepeatedActions(
    uniqueActions(
      [actions.primary, actions.secondary, ...additionalRemediationActions],
      new Set(),
    ),
    repeatedRemediationLabels,
  );
  if (dismissTargets.length > 0) {
    rowActions.push({
      icon: <BellOff className="h-4 w-4" />,
      label: dismissTargets.length === 1 ? "Dismiss alert" : "Dismiss alerts",
      onClick: () => setDismissOpen(true),
    });
  }
  if (restoreTargets.length > 0) {
    rowActions.push({
      icon: <Bell className="h-4 w-4" />,
      label: restoreTargets.length === 1 ? "Restore alert" : "Restore alerts",
      disabled: restoreMutation.isPending,
      onClick: () =>
        restoreMutation.mutate(
          { alerts: restoreTargets },
          {
            onSuccess: (result) => onTargetsCompleted?.(result.succeeded),
          },
        ),
    });
  }
  rowActions.push(...overflow);

  const panelOverflowActions = contextualizeRepeatedActions(
    uniqueActions(
      [actions.secondary, ...additionalRemediationActions, ...overflow],
      new Set(),
    ),
    repeatedRemediationLabels,
  );
  const overflowMenu =
    panelOverflowActions.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`More actions for ${item.name}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {panelOverflowActions.map((action) => (
            <DropdownMenuItem
              key={action.label}
              onClick={action.onClick}
              variant={action.variant}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  const completedTargets = onTargetsCompleted;

  if (variant === "actions") {
    return (
      <>
        <div className="flex justify-end">
          <TableRowActions itemName={item.name} actions={rowActions} />
        </div>
        <DismissAlertDialog
          open={dismissOpen}
          onClose={() => setDismissOpen(false)}
          targets={dismissTargets}
          onDismissed={completedTargets}
        />
        <UninstallServerDialog
          open={uninstallOpen}
          onClose={() => setUninstallOpen(false)}
          installs={uninstallInstalls}
        />
      </>
    );
  }

  if (variant === "details") {
    return (
      <div className="space-y-3 bg-muted/20 px-4 py-3">
        {explained.map((issue) => {
          const guidance = describeMcpServerIssue(issue);
          const actionOwner = describeMcpIssueActionOwners({
            issues: relevant.filter(
              (candidate) => candidate.kind === issue.kind,
            ),
            servers,
          });
          const rawDetail = rawDetailFor(issue);
          return (
            <div key={issue.kind} className="space-y-2">
              <p className={cn(typeRole({ role: "body" }), "max-w-prose")}>
                <span>{guidance.what}</span>{" "}
                {issue.audience === "you" && !issue.muted ? (
                  <span className="text-muted-foreground">{guidance.fix}</span>
                ) : (
                  <span className="text-muted-foreground">
                    {issue.muted
                      ? dismissedSentence(issue.mutedReason)
                      : actionOwner.sentence}
                  </span>
                )}
              </p>
              {rawDetail && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2.5 font-mono text-xs text-muted-foreground">
                  {rawDetail}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (variant === "primary-action") {
    const action = actions.primary;
    if (action) {
      const compactLabel =
        {
          "Re-authenticate": "Auth",
          "View logs": "Logs",
        }[action.label] ?? action.label;
      return (
        <Button
          variant={action.variant ?? "outline"}
          size="sm"
          className="flex-1 gap-1 px-2 text-xs"
          aria-label={action.label}
          data-testid={action.testId}
          onClick={action.onClick}
        >
          {action.icon}
          <span>{compactLabel}</span>
        </Button>
      );
    }
    if (restoreTargets.length > 0) {
      return (
        <Button
          variant="outline"
          size="sm"
          className="flex-1 gap-1 px-2 text-xs"
          disabled={restoreMutation.isPending}
          onClick={() =>
            restoreMutation.mutate(
              { alerts: restoreTargets },
              {
                onSuccess: (result) => onTargetsCompleted?.(result.succeeded),
              },
            )
          }
        >
          <Bell className="h-4 w-4" />
          Restore
        </Button>
      );
    }
    return (
      <Button
        variant="outline"
        size="sm"
        className="flex-1 gap-1 px-2 text-xs"
        onClick={() => router.push(detailHref())}
      >
        Open
      </Button>
    );
  }

  return (
    <div
      className={cn("rounded-lg border bg-card", className)}
      data-testid={`mcp-registry-attention-row-${item.name}`}
    >
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {!hideName && (
              <>
                <McpCatalogIcon
                  icon={item.icon}
                  catalogId={item.id}
                  size={16}
                />
                <Link
                  href={detailHref()}
                  className={cn(
                    typeRole({ role: "section-title" }),
                    "truncate hover:underline",
                  )}
                >
                  {item.name}
                </Link>
              </>
            )}
            {explained.map((issue) => (
              <McpServerIssueBadge
                key={issue.kind}
                issue={issue}
                showDetail={false}
              />
            ))}
          </div>
          {explained.map((issue) => {
            const guidance = describeMcpServerIssue(issue);
            const actionOwner = describeMcpIssueActionOwners({
              issues: relevant.filter(
                (candidate) => candidate.kind === issue.kind,
              ),
              servers,
            });
            const since = issue.since
              ? formatRelativeTimeFromNow(issue.since, { neverLabel: "" })
              : "";
            return (
              <p
                key={issue.kind}
                className={cn(typeRole({ role: "body" }), "mt-1.5 max-w-prose")}
              >
                <span>{guidance.what}</span>
                {since && <span> Failing since {since}.</span>}{" "}
                {issue.audience === "you" && !issue.muted ? (
                  <span className="text-muted-foreground">{guidance.fix}</span>
                ) : (
                  <span className="text-muted-foreground">
                    {issue.muted
                      ? dismissedSentence(issue.mutedReason)
                      : actionOwner.sentence}
                  </span>
                )}
              </p>
            );
          })}
          {disclosedDetail && (
            <p className={cn(typeRole({ role: "meta" }), "mt-1.5")}>
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                aria-expanded={showDetail}
                aria-controls={detailId}
                onClick={() => setShowDetail((value) => !value)}
              >
                {showDetail ? "Hide details" : "Show details"}
              </button>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end sm:pt-0.5">
          {panelActions === "dismiss-only" ? (
            dismissOnlyAction
          ) : (
            <>
              {actions.secondary && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={actions.secondary.testId}
                  onClick={actions.secondary.onClick}
                >
                  {actions.secondary.label}
                </Button>
              )}
              {panelPrimaryAction}
              {queueActions}
              {overflowMenu}
            </>
          )}
        </div>
      </div>
      {showDetail && disclosedDetail && (
        <pre
          id={detailId}
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t bg-muted/40 px-4 py-2.5 font-mono text-xs text-muted-foreground"
        >
          {disclosedDetail}
        </pre>
      )}
      <DismissAlertDialog
        open={dismissOpen}
        onClose={() => setDismissOpen(false)}
        targets={dismissTargets}
        onDismissed={onTargetsCompleted}
      />
      <UninstallServerDialog
        open={uninstallOpen}
        onClose={() => setUninstallOpen(false)}
        installs={uninstallInstalls}
      />
    </div>
  );
}

/**
 * The dismissed state in words. The backend calls it a mute, but that
 * transport vocabulary never reaches the interface.
 */
function dismissedSentence(reason: string | null): string {
  const base = "You dismissed this alert, so it is not counted for you.";
  return reason ? `${base} Your note: "${reason}"` : base;
}

function distinctByKind(issues: McpServerIssue[]): McpServerIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    if (seen.has(i.kind)) return false;
    seen.add(i.kind);
    return true;
  });
}

function uniqueActions(
  actions: Array<Action | undefined>,
  excludedIds: Set<string | undefined>,
): Action[] {
  const seen = new Set(excludedIds);
  return actions.filter((action): action is Action => {
    if (!action || seen.has(action.actionId)) return false;
    seen.add(action.actionId);
    return true;
  });
}

function repeatedActionLabels(actions: Array<Action | undefined>): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const action of actions) {
    if (!action) continue;
    if (seen.has(action.label)) repeated.add(action.label);
    seen.add(action.label);
  }
  return repeated;
}

function contextualizeRepeatedActions(
  actions: Action[],
  repeatedLabels: Set<string>,
): Action[] {
  const contextualized = actions.map((action) =>
    repeatedLabels.has(action.label) && action.context
      ? { ...action, label: `${action.label} for ${action.context}` }
      : action,
  );
  const counts = new Map<string, number>();
  for (const action of contextualized) {
    counts.set(action.label, (counts.get(action.label) ?? 0) + 1);
  }
  return contextualized.map((action) =>
    (counts.get(action.label) ?? 0) > 1 && action.contextId
      ? { ...action, label: `${action.label} (${action.contextId})` }
      : action,
  );
}
