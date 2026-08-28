"use client";

import type { McpDeploymentStatusEntry } from "@archestra/shared";
import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
} from "@tanstack/react-table";
import {
  Bell,
  BellOff,
  FileSearch,
  KeyRound,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCw,
  Route,
  Server,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useState } from "react";
import { RowClickShield } from "@/components/agent-pages/row-click-shield";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import type { BulkRangeSelectionController } from "@/lib/bulk-range-selection";
import { useFeature } from "@/lib/config/config.query";
import { typeRole } from "@/lib/design/type-scale";
import { useReinstallInternalMcpCatalogItem } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  type McpDeploymentFeedState,
  useMcpServers,
  useRestoreMcpServerAlerts,
} from "@/lib/mcp/mcp-server.query";
import {
  canFixInstall,
  facetIssues,
  type McpServerAttentionFacet,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { cn } from "@/lib/utils";
import { useCanModifyCatalogItem } from "./catalog-edit-access";
import { shouldShowMcpCardChatButton } from "./chat-button-visibility";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusIconDot,
  type DeploymentStatusSummary,
} from "./deployment-status";
import type { DismissAlertTarget } from "./dismiss-alert-dialog";
import { DismissAlertDialog } from "./dismiss-alert-dialog";
import { McpCapabilityBadges } from "./mcp-capability-badges";
import {
  getMcpServerActionModel,
  mcpServerAction,
} from "./mcp-server-actions-model";
import { mcpServerAlertTarget } from "./mcp-server-alert-target";
import { describeMcpIssueActionOwners } from "./mcp-server-attention-owner";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
import { McpServerIssueBadge } from "./mcp-server-issue-badge";
import { McpServerIssueNotice } from "./mcp-server-issue-notice";
import {
  UninstallServerDialog,
  type UninstallServerInstall,
} from "./uninstall-server-dialog";
import { useChatWithCatalogItem } from "./use-chat-with-catalog-item";

type McpServerTableProps = {
  items: CatalogItem[];
  getServerInfo: (item: CatalogItem) => {
    installedServer?: InstalledServer;
    isInstallInProgress?: boolean;
  };
  envLabelByCatalog: Map<string, string | null>;
  /** Outstanding issues per catalog id; items with none are absent. */
  issuesByCatalog: Map<string, McpServerIssue[]>;
  /**
   * Whether the live deployment feed has anything to say. An empty
   * `deploymentStatuses` means "not yet" on Kubernetes and "never" everywhere
   * else, and a Status column that cannot tell them apart calls a server
   * healthy on the strength of data that has not arrived.
   */
  deploymentFeedState: McpDeploymentFeedState;
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  installingItemId: string | null;
  onInstall: (item: CatalogItem) => void;
  onReinstall: (
    item: CatalogItem,
    flaggedInstalls?: Array<{ id: string; name: string }>,
    options?: { alsoReinstallCatalog?: boolean },
  ) => void | Promise<void>;
  onCancelInstallation?: (serverId: string) => void;
  selection?: {
    rowSelection: RowSelectionState;
    onRowSelectionChange: OnChangeFn<RowSelectionState>;
    onPageRowIdsChange: (ids: string[]) => void;
    rangeSelection: BulkRangeSelectionController;
  };
  attention?: {
    facet: McpServerAttentionFacet;
    servers: InstalledServer[];
    rowSelection: RowSelectionState;
    onRowSelectionChange: (selection: RowSelectionState) => void;
    onTargetsCompleted: (targets: readonly DismissAlertTarget[]) => void;
  };
};

// Table variant of the registry catalog list. The name cell links to the item
// detail page and the Actions column keeps parity with the card buttons. The
// table has room for compact icon buttons, so applicable actions stay visible.
export function McpServerTable({
  items,
  getServerInfo,
  envLabelByCatalog,
  issuesByCatalog,
  deploymentFeedState,
  deploymentStatuses,
  installingItemId,
  onInstall,
  onReinstall,
  onCancelInstallation,
  selection,
  attention,
}: McpServerTableProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const canSelect = (item: CatalogItem) =>
    (!!attention || !!getServerInfo(item).installedServer) &&
    installingItemId !== item.id &&
    !getServerInfo(item).isInstallInProgress;
  const deploymentSummaryFor = (
    item: CatalogItem,
  ): DeploymentStatusSummary | null => {
    const installedServer = getServerInfo(item).installedServer;
    if (
      item.serverType !== "local" ||
      !installedServer ||
      deploymentFeedState !== "ready"
    ) {
      return null;
    }
    return computeDeploymentStatusSummary(
      [installedServer.id],
      deploymentStatuses,
    );
  };

  const standardColumns: ColumnDef<CatalogItem>[] = [
    createSelectColumn<CatalogItem>({
      rowLabel: (item) => `Select ${item.name}`,
      allLabel: "Select all MCP servers on this page",
      canSelect,
      disabledReason: (item) =>
        !attention && !getServerInfo(item).installedServer
          ? "Install this server before selecting it"
          : "Wait for installation to finish",
    }),
    {
      id: "name",
      accessorKey: "name",
      header: "MCP Server",
      size: 360,
      cell: ({ row }) => {
        const item = row.original;
        return (
          <McpServerNameCell
            item={item}
            environmentLabel={envLabelByCatalog.get(item.id)}
            deploymentSummary={deploymentSummaryFor(item)}
          />
        );
      },
    },
    {
      id: "tools",
      size: 90,
      header: () => <div className="text-right">Tools</div>,
      cell: ({ row }) => (
        <div className="text-right text-sm text-muted-foreground">
          {row.original.toolCount ?? 0}
        </div>
      ),
    },
    {
      id: "author",
      // Visibility badges cap their label at 180px. Include the cell padding
      // so the full badge fits without donating extra space to this column.
      size: 212,
      header: "Accessible to",
      cell: ({ row }) => (
        <ResourceVisibilityBadge
          scope={row.original.scope}
          teams={row.original.teams}
          authorId={row.original.authorId}
          authorName={row.original.authorName}
          currentUserId={currentUserId}
          showSelfAsMe
        />
      ),
    },
    {
      id: "status",
      // The table is a scanning surface: the status label is enough here.
      // Diagnosis and remediation live on the server page and attention facet.
      size: 190,
      header: "Status",
      cell: ({ row }) => {
        const item = row.original;
        const { installedServer, isInstallInProgress } = getServerInfo(item);
        if (installingItemId === item.id || isInstallInProgress) {
          return (
            <span
              className={cn(
                typeRole({ role: "body" }),
                "inline-flex items-center gap-1.5",
              )}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Installing…
            </span>
          );
        }
        if (item.serverType === "builtin") {
          return <Badge variant="secondary">Built-in</Badge>;
        }
        // Worst live issue first, since issues are kind-ordered. An item whose
        // only trouble has been muted still shows it, muted.
        const issues = issuesByCatalog.get(item.id) ?? [];
        const issue = issues.find((i) => !i.muted) ?? issues[0];
        if (issue) {
          return (
            <div className="flex min-h-9 items-center">
              <McpServerIssueBadge issue={issue} showDetail={false} />
            </div>
          );
        }
        // Nothing installed means there is no runtime to have a status, and a
        // catalog entry nobody has connected is not "Healthy" — it is nothing.
        if (!installedServer) return null;
        return <InstalledStatusCell />;
      },
    },
    {
      id: "actions",
      size: 160,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => {
        const item = row.original;
        const { installedServer, isInstallInProgress } = getServerInfo(item);
        return (
          <RowClickShield>
            <McpServerRowActions
              item={item}
              installedServer={installedServer}
              issues={issuesByCatalog.get(item.id) ?? []}
              isInstalling={
                installingItemId === item.id || !!isInstallInProgress
              }
              onInstall={onInstall}
              onReinstall={onReinstall}
              onCancelInstallation={onCancelInstallation}
            />
          </RowClickShield>
        );
      },
    },
  ];

  const attentionColumns: ColumnDef<CatalogItem>[] = attention
    ? [
        createSelectColumn<CatalogItem>({
          rowLabel: (item) => `Select ${item.name}`,
          allLabel:
            attention.facet === "muted"
              ? "Select all restorable alerts"
              : "Select all alerts",
        }),
        {
          id: "name",
          accessorKey: "name",
          header: "MCP Server",
          size: 360,
          cell: ({ row }) => {
            const item = row.original;
            return (
              <McpServerNameCell
                item={item}
                environmentLabel={envLabelByCatalog.get(item.id)}
                deploymentSummary={deploymentSummaryFor(item)}
              />
            );
          },
        },
        {
          id: "issue",
          header: "Issue",
          size: 420,
          cell: ({ row }) => {
            const item = row.original;
            const issues = attentionRawIssues(item);
            const owner = issues.length
              ? describeMcpIssueActionOwners({
                  issues,
                  servers: attentionServers(item),
                }).label
              : "—";
            const reasons = Array.from(
              new Set(
                issues
                  .map((issue) => issue.mutedReason?.trim())
                  .filter((reason): reason is string => !!reason),
              ),
            );
            return (
              <div className="min-w-0 space-y-1.5">
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {attentionIssues(item).map((issue) => (
                    <McpServerIssueBadge
                      key={issue.kind}
                      issue={issue}
                      showDetail={false}
                    />
                  ))}
                </div>
                <p className="break-words text-xs text-muted-foreground">
                  {attention.facet === "muted" ? (
                    <>
                      {reasons.length > 0
                        ? `Reason: ${reasons.join("; ")}`
                        : "No dismissal reason"}
                      <span aria-hidden> · </span>
                    </>
                  ) : null}
                  <span title={owner}>Owner: {owner}</span>
                </p>
              </div>
            );
          },
        },
        {
          id: "actions",
          header: () => <div className="text-right">Actions</div>,
          size: 112,
          cell: ({ row }) => {
            const item = row.original;
            return (
              <McpServerIssueNotice
                variant="actions"
                item={item}
                issues={issuesByCatalog.get(item.id) ?? []}
                facet={attention.facet}
                servers={attentionServers(item)}
                onTargetsCompleted={attention.onTargetsCompleted}
              />
            );
          },
        },
      ]
    : [];

  const columns = attention ? attentionColumns : standardColumns;

  function attentionIssues(item: CatalogItem): McpServerIssue[] {
    const issues = attentionRawIssues(item);
    const seen = new Set<string>();
    return issues.filter((issue) => {
      if (seen.has(issue.kind)) return false;
      seen.add(issue.kind);
      return true;
    });
  }

  function attentionRawIssues(item: CatalogItem): McpServerIssue[] {
    if (!attention) return [];
    return facetIssues(issuesByCatalog.get(item.id) ?? [], attention.facet);
  }

  function attentionServers(item: CatalogItem): InstalledServer[] {
    return (
      attention?.servers.filter((server) => server.catalogId === item.id) ?? []
    );
  }

  return (
    <DataTable
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      rowSelection={attention?.rowSelection ?? selection?.rowSelection}
      onRowSelectionChange={
        attention?.onRowSelectionChange ?? selection?.onRowSelectionChange
      }
      rangeSelection={selection?.rangeSelection}
      onPageRowIdsChange={attention ? undefined : selection?.onPageRowIdsChange}
      hideSelectedCount={!!attention}
      onRowClick={
        attention ? undefined : (row) => router.push(`/mcp/registry/${row.id}`)
      }
      emptyIcon={Route}
      emptyMessage="No MCP servers found."
      hidePaginationWhenSinglePage
      fixedWidthColumnIds={
        attention
          ? ["select", "name", "actions"]
          : ["name", "tools", "author", "actions"]
      }
      flexibleColumnIds={[attention ? "issue" : "status"]}
    />
  );
}

// Per-row action cluster mirroring McpServerCard's buttons. The heavy lifting
// (install/reinstall flows, dialogs) stays in the parent via callbacks, same
// as for the cards; this component only re-derives the card's visibility
// rules from the shared queries.
const McpServerRowActions = memo(function McpServerRowActions({
  item,
  installedServer,
  issues,
  isInstalling,
  onInstall,
  onReinstall,
  onCancelInstallation,
}: {
  item: CatalogItem;
  installedServer?: InstalledServer;
  issues: McpServerIssue[];
  isInstalling: boolean;
  onInstall: McpServerTableProps["onInstall"];
  onReinstall: McpServerTableProps["onReinstall"];
  onCancelInstallation?: (serverId: string) => void;
}) {
  const { startChat, isCreating: isChatCreating } = useChatWithCatalogItem();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const isLocalMcpEnabled = useFeature("orchestratorK8sRuntime");
  const { data: allMcpServers } = useMcpServers();
  const { data: canManageInstalls } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const restoreMutation = useRestoreMcpServerAlerts();
  const [dismissOpen, setDismissOpen] = useState(false);
  const isBuiltin = item.serverType === "builtin";
  const isLocal = item.serverType === "local";
  const { canModify: canEditCatalog } = useCanModifyCatalogItem(
    !isBuiltin ? item : null,
  );
  const reinstallCatalogMutation = useReinstallInternalMcpCatalogItem();
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const actionModel = getMcpServerActionModel(item);
  const connectionsAction = mcpServerAction(actionModel, "connections");
  const logsAction = mcpServerAction(actionModel, "logs");
  const editAction = mcpServerAction(actionModel, "edit");

  const allServersForCatalog = (allMcpServers ?? []).filter(
    (s) => s.catalogId === item.id,
  );
  const personalServersForCatalog = allServersForCatalog.filter(
    (s) =>
      s.ownerId === currentUserId &&
      (s.scope === "personal" || (!s.scope && !s.teamId)),
  );
  const hasPersonalConnection = personalServersForCatalog.length > 0;
  const hasLocalInstalls = allServersForCatalog.some(
    (s) => s.serverType === "local",
  );

  const showChat = shouldShowMcpCardChatButton({
    toolsCount: item.toolCount ?? 0,
    isBuiltin,
    hasInstallation: allServersForCatalog.length > 0,
  });

  // Reinstall visibility mirrors the card's combined admin/tenant rule: an
  // installs admin who does not own the connection used to be told to
  // reinstall and then found no button anywhere.
  const viewer = {
    userId: currentUserId ?? null,
    canManageInstalls: !!canManageInstalls,
  };
  const userFlaggedInstalls = allServersForCatalog.filter(
    (s) => s.reinstallRequired && canFixInstall({ server: s, viewer }),
  );
  const needsReinstall = userFlaggedInstalls.length > 0;
  const needsCatalogReinstall =
    isLocal &&
    item.multitenant === true &&
    item.catalogReinstallRequired === true;
  const showAdminCatalogReinstall = needsCatalogReinstall && canEditCatalog;
  const isCurrentUserAuthenticated =
    currentUserId && installedServer?.users
      ? installedServer.users.includes(currentUserId)
      : false;
  const showCombinedReinstall =
    showAdminCatalogReinstall ||
    (needsReinstall && !needsCatalogReinstall && isCurrentUserAuthenticated);
  const showApprovalPanel = item.imageApprovalRequired === true;

  const triggerCombinedReinstall = () => {
    const flagged = userFlaggedInstalls.map((s) => ({
      id: s.id,
      name: s.name,
    }));
    if (showAdminCatalogReinstall && needsReinstall) {
      return onReinstall(item, flagged, { alsoReinstallCatalog: true });
    }
    if (showAdminCatalogReinstall) {
      return reinstallCatalogMutation.mutate(item.id);
    }
    return onReinstall(item, flagged);
  };

  // The connections this row's alerts are about, and whether the viewer may
  // remove or mute one. Naming a single connection is only honest when the
  // alerts point at exactly one; with several, the credentials tab is the
  // place that can show them all.
  const alertingConnectionIds = new Set(issues.map((i) => i.serverId));
  const alertingConnections = allServersForCatalog.filter((s) =>
    alertingConnectionIds.has(s.id),
  );
  const removableConnection =
    alertingConnections.length === 1 &&
    canFixInstall({ server: alertingConnections[0], viewer })
      ? alertingConnections[0]
      : null;
  const queueTargets = issues.map((issue) => ({
    issue,
    target: mcpServerAlertTarget({
      issue,
      item,
      servers: allServersForCatalog,
    }),
  }));
  const dismissTargets = queueTargets
    .filter(({ issue }) => !issue.muted)
    .map(({ target }) => target);
  const restoreTargets = queueTargets
    .filter(({ issue }) => issue.muted)
    .map(({ target }) => target);

  // The most recent personal install, as on the card's uninstall dialog; an
  // admin with no connection of their own removes the one that is alerting.
  const uninstallInstalls: UninstallServerInstall[] = (() => {
    const install =
      personalServersForCatalog
        .slice()
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )[0] ?? removableConnection;
    return install
      ? [
          {
            server: { id: install.id, name: install.name },
            assignedAgents: install.assignedAgents ?? [],
          },
        ]
      : [];
  })();

  const actionableIssues = issues.filter(
    (issue) => !issue.muted && issue.audience === "you",
  );
  const reauthIssue = actionableIssues.find(
    (issue) => issue.kind === "needs-reauth",
  );
  const hasRuntimeIssue = actionableIssues.some(
    (issue) => issue.kind === "failed-to-start" || issue.kind === "not-running",
  );
  const actions: TableRowAction[] = [];
  const alertActions: TableRowAction[] = [];
  if (reauthIssue) {
    actions.push({
      icon: <KeyRound className="h-4 w-4" />,
      label: "Re-authenticate",
      href: `/mcp/registry/${item.id}?tab=credentials${reauthIssue.serverId ? `&server=${reauthIssue.serverId}` : ""}`,
    });
  }
  if (hasRuntimeIssue) {
    actions.push({
      icon: <FileSearch className="h-4 w-4" />,
      label: logsAction.label,
      href: logsAction.href,
    });
  }
  if (showChat) {
    actions.push({
      icon: <MessageSquare className="h-4 w-4" />,
      label: isChatCreating ? "Creating…" : "Chat",
      disabled: isChatCreating,
      onClick: () => startChat(item),
    });
  }
  if (!isInstalling && !isBuiltin) {
    if (showCombinedReinstall) {
      actions.push({
        icon: <RefreshCw className="h-4 w-4" />,
        label: "Reinstall",
        variant: "destructive",
        permissions: showAdminCatalogReinstall
          ? { mcpRegistry: ["update"] }
          : { mcpServerInstallation: ["create"] },
        disabled: reinstallCatalogMutation.isPending || showApprovalPanel,
        disabledTooltip: showApprovalPanel
          ? "The Docker image needs admin approval first"
          : undefined,
        onClick: () => void triggerCombinedReinstall(),
      });
    }
    if (hasPersonalConnection) {
      actions.push({
        icon: <Trash2 className="h-4 w-4" />,
        label: "Uninstall",
        // Removing a connection is its own capability, as on the card.
        permissions: { mcpServerInstallation: ["delete"] },
        onClick: () => setUninstallOpen(true),
      });
    } else if (removableConnection) {
      // An alert with no exit: before this, an admin looking at somebody
      // else's broken connection could re-authenticate it or nothing.
      actions.push({
        icon: <Trash2 className="h-4 w-4" />,
        label: "Remove this connection",
        permissions: { mcpServerInstallation: ["delete"] },
        onClick: () => setUninstallOpen(true),
      });
    } else if (!(isLocal && showApprovalPanel)) {
      // Install stays hidden for local items while the image awaits admin
      // approval (the card drops it too — the button would only fail the gate).
      actions.push({
        icon: isLocal ? (
          <Server className="h-4 w-4" />
        ) : (
          <User className="h-4 w-4" />
        ),
        label: "Install",
        permissions: { mcpServerInstallation: ["create"] },
        disabled: isLocal && !isLocalMcpEnabled,
        disabledTooltip:
          isLocal && !isLocalMcpEnabled
            ? LOCAL_MCP_DISABLED_TOOLTIP
            : undefined,
        onClick: () => onInstall(item),
      });
    }
  }
  // Dismiss/Restore is queue management, so reserve inline space for it even
  // when the row has enough capabilities to overflow its action cluster.
  if (dismissTargets.length > 0) {
    alertActions.push({
      icon: <BellOff className="h-4 w-4" />,
      label: dismissTargets.length === 1 ? "Dismiss alert" : "Dismiss alerts",
      onClick: () => setDismissOpen(true),
    });
  }
  if (restoreTargets.length > 0) {
    alertActions.push({
      icon: <Bell className="h-4 w-4" />,
      label: restoreTargets.length === 1 ? "Restore alert" : "Restore alerts",
      disabled: restoreMutation.isPending,
      onClick: () =>
        restoreMutation.mutate({
          alerts: restoreTargets,
        }),
    });
  }
  if (canEditCatalog) {
    actions.push({
      icon: <Pencil className="h-4 w-4" />,
      label: editAction.label,
      href: editAction.href,
    });
  }
  if (!isBuiltin) {
    actions.push({
      icon: <Users className="h-4 w-4" />,
      label: connectionsAction.label,
      href: connectionsAction.href,
    });
  }
  if (hasLocalInstalls && !hasRuntimeIssue) {
    actions.push({
      icon: <FileSearch className="h-4 w-4" />,
      label: logsAction.label,
      href: logsAction.href,
    });
  }
  if (actions.length === 0 && alertActions.length === 0) return null;

  const inlineActionCount = Math.max(0, 3 - alertActions.length);
  const inlineActions = [
    ...actions.slice(0, inlineActionCount),
    ...alertActions,
  ];
  const dropdownActions = actions.slice(inlineActionCount);

  return (
    <>
      <div className="flex justify-end">
        <TableRowActions
          itemName={item.name}
          actions={inlineActions}
          dropdownActions={dropdownActions}
        />
      </div>

      <UninstallServerDialog
        open={uninstallOpen}
        onClose={() => setUninstallOpen(false)}
        installs={uninstallInstalls}
        isCancelingInstallation={isInstalling}
        onCancelInstallation={onCancelInstallation}
      />

      <DismissAlertDialog
        open={dismissOpen}
        onClose={() => setDismissOpen(false)}
        targets={dismissTargets}
      />
    </>
  );
});

// === internal helpers ===

function McpServerNameCell({
  item,
  environmentLabel,
  deploymentSummary,
}: {
  item: CatalogItem;
  environmentLabel: string | null | undefined;
  deploymentSummary: DeploymentStatusSummary | null;
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="relative shrink-0">
          <McpCatalogIcon icon={item.icon} catalogId={item.id} size={16} />
          {deploymentSummary && (
            <DeploymentStatusIconDot summary={deploymentSummary} />
          )}
        </span>
        <span className="truncate font-medium">{item.name}</span>
        {environmentLabel && (
          <Badge variant="outline" className="shrink-0 text-muted-foreground">
            <span className="max-w-32 truncate">{environmentLabel}</span>
          </Badge>
        )}
        <McpCapabilityBadges
          providesUi={item.providesUi}
          providesSkills={item.providesSkills}
          skillCount={item.skillCount}
        />
      </div>
      {item.description && (
        <div className="truncate text-xs text-muted-foreground">
          {item.description}
        </div>
      )}
    </div>
  );
}

function InstalledStatusCell() {
  return (
    <div
      className={cn(
        typeRole({ role: "body" }),
        "flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1",
      )}
    >
      <Badge variant="secondary">Installed</Badge>
    </div>
  );
}

// Plain-text variant of LOCAL_MCP_DISABLED_MESSAGE (the shared const is JSX
// with a docs link; tooltips on table action buttons only take strings).
const LOCAL_MCP_DISABLED_TOOLTIP =
  "Unable to connect to Kubernetes cluster. Ensure K8s is running and the orchestrator configuration is correct.";
