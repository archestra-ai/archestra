"use client";

import type { McpDeploymentStatusEntry } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Bell,
  BellOff,
  Download,
  FileSearch,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useFeature } from "@/lib/config/config.query";
import { typeRole } from "@/lib/design/type-scale";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useReinstallInternalMcpCatalogItem } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  type McpDeploymentFeedState,
  useBulkUninstallMcpServers,
  useMcpServers,
  useUnmuteMcpServerAlert,
} from "@/lib/mcp/mcp-server.query";
import {
  canFixInstall,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { cn } from "@/lib/utils";
import { useCanModifyCatalogItem } from "./catalog-edit-access";
import { shouldShowMcpCardChatButton } from "./chat-button-visibility";
import { McpCapabilityBadges } from "./mcp-capability-badges";
import {
  computeDeploymentStatusSummary,
  getDeploymentLabel,
} from "./deployment-status";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
import { McpServerIssueStatusCell } from "./mcp-server-issue-badge";
import { MuteAlertDialog } from "./mute-alert-dialog";
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
};

// Table variant of the registry catalog list. The name cell links to the item
// detail page and the Actions column keeps parity with the card buttons:
// chat, install, uninstall, reinstall, and server settings, with credentials
// and logs in the overflow menu.
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
}: McpServerTableProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [bulkUninstallOpen, setBulkUninstallOpen] = useState(false);
  const bulkUninstall = useBulkUninstallMcpServers();

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
    selectAllMatching,
  } = useBulkSelection({
    rows: items,
    getId: (item) => item.id,
    // An install in flight is neither installable nor uninstallable yet.
    canSelect: (item) => !getServerInfo(item).isInstallInProgress,
    filterSignature: `mcp-registry:${items.length}`,
    matchDescription: "match the current filters",
  });

  /**
   * One selection, two actions: each button acts on the part of it the action
   * can apply to. Reinstall stays a row action — it carries per-server options
   * the bar has nowhere to ask about.
   */
  const selectedToInstall = selected.filter(
    (item) => !getServerInfo(item).installedServer,
  );
  const selectedToUninstall = selected
    .filter((item) => getServerInfo(item).installedServer)
    .map((item) => ({
      id: getServerInfo(item).installedServer?.id ?? item.id,
      name: item.name,
    }));

  const columns: ColumnDef<CatalogItem>[] = [
    createSelectColumn<CatalogItem>({
      rowLabel: (item) => `Select ${item.name}`,
      allLabel: "Select all MCP servers on this page",
      canSelect: (item) => !getServerInfo(item).installedServer,
    }),
    {
      id: "name",
      accessorKey: "name",
      header: "MCP Server",
      size: 600,
      cell: ({ row }) => {
        const item = row.original;
        const environmentLabel = envLabelByCatalog.get(item.id);
        return (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <McpCatalogIcon icon={item.icon} catalogId={item.id} size={16} />
              <span className="truncate font-medium">{item.name}</span>
              {environmentLabel && (
                <Badge
                  variant="outline"
                  className="shrink-0 text-muted-foreground"
                >
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
      size: 140,
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
      // Wide enough for the longest issue label ("Needs re-authentication")
      // plus a line of cause under it; both are capped to the cell so nothing
      // can spill into the actions column.
      size: 260,
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
          return <McpServerIssueStatusCell issue={issue} />;
        }
        // Nothing installed means there is no runtime to have a status, and a
        // catalog entry nobody has connected is not "Healthy" — it is nothing.
        if (!installedServer) return null;
        return (
          <span className={typeRole({ role: "body" })}>
            {installedStatusLabel({
              isLocal: item.serverType === "local",
              feedState: deploymentFeedState,
              serverId: installedServer.id,
              deploymentStatuses,
            })}
          </span>
        );
      },
    },
    {
      id: "actions",
      size: 190,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => {
        const item = row.original;
        const { installedServer, isInstallInProgress } = getServerInfo(item);
        return (
          <McpServerRowActions
            item={item}
            installedServer={installedServer}
            issues={issuesByCatalog.get(item.id) ?? []}
            isInstalling={installingItemId === item.id || !!isInstallInProgress}
            onInstall={onInstall}
            onReinstall={onReinstall}
            onCancelInstallation={onCancelInstallation}
          />
        );
      },
    },
  ];

  return (
    <>
      <BulkActionsBar
        count={selected.length}
        noun="server"
        onClear={clearSelection}
        busy={bulkUninstall.isPending}
        selectAllMatching={selectAllMatching}
        className="mb-3"
      >
        <PermissionButton
          permissions={{ mcpServerInstallation: ["create"] }}
          variant="outline"
          size="sm"
          disabled={selectedToInstall.length === 0}
          tooltip={
            selectedToInstall.length === 0
              ? "Every selected server is already installed."
              : undefined
          }
          onClick={() => {
            for (const item of selectedToInstall) onInstall(item);
            clearSelection();
          }}
        >
          <Download className="h-4 w-4" />
          <span>
            Install{countSuffix(selectedToInstall.length, selected.length)}
          </span>
        </PermissionButton>
        <PermissionButton
          permissions={{ mcpServerInstallation: ["delete"] }}
          variant="destructive"
          size="sm"
          disabled={selectedToUninstall.length === 0}
          tooltip={
            selectedToUninstall.length === 0
              ? "None of the selected servers are installed."
              : undefined
          }
          onClick={() => setBulkUninstallOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          <span>
            Uninstall{countSuffix(selectedToUninstall.length, selected.length)}
          </span>
        </PermissionButton>
      </BulkActionsBar>

      <DataTable
        columns={columns}
        data={items}
        getRowId={(row) => row.id}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        onPageRowIdsChange={onPageRowIdsChange}
        hideSelectedCount
        onRowClick={(row) => router.push(`/mcp/registry/${row.id}`)}
        emptyMessage="No MCP servers found."
        hidePaginationWhenSinglePage
      />

      {bulkUninstallOpen && (
        <DeleteConfirmDialog
          open={bulkUninstallOpen}
          onOpenChange={setBulkUninstallOpen}
          title="Uninstall MCP servers"
          description={`Uninstall ${selectedToUninstall.length} ${
            selectedToUninstall.length === 1 ? "server" : "servers"
          }? Agents using their tools lose access.`}
          isPending={bulkUninstall.isPending}
          onConfirm={() => {
            bulkUninstall.mutate(selectedToUninstall, {
              onSuccess: (outcome) => {
                reportBulkOutcome({
                  outcome,
                  verb: "Uninstalled",
                  failureVerb: "uninstall",
                  noun: "server",
                });
                setBulkUninstallOpen(false);
                if (outcome.failed.length === 0) clearSelection();
              },
            });
          }}
          confirmLabel="Uninstall servers"
          pendingLabel="Uninstalling..."
        />
      )}
    </>
  );
}

// === internal components ===

// Per-row action cluster mirroring McpServerCard's buttons. The heavy lifting
// (install/reinstall flows, dialogs) stays in the parent via callbacks, same
// as for the cards; this component only re-derives the card's visibility
// rules from the shared queries.
function McpServerRowActions({
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
  const router = useRouter();
  const { startChat, isCreating: isChatCreating } = useChatWithCatalogItem();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const isLocalMcpEnabled = useFeature("orchestratorK8sRuntime");
  const { data: allMcpServers } = useMcpServers();
  const { data: canManageInstalls } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const unmuteMutation = useUnmuteMcpServerAlert();
  const [muteOpen, setMuteOpen] = useState(false);
  const isBuiltin = item.serverType === "builtin";
  const isLocal = item.serverType === "local";
  const { canModify: canEditCatalog } = useCanModifyCatalogItem(
    !isBuiltin ? item : null,
  );
  const reinstallCatalogMutation = useReinstallInternalMcpCatalogItem();
  const [uninstallOpen, setUninstallOpen] = useState(false);

  const allServersForCatalog = (allMcpServers ?? []).filter(
    (s) => s.catalogId === item.id,
  );
  const personalServersForCatalog = allServersForCatalog.filter(
    (s) => s.ownerId === currentUserId && !s.teamId,
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

  // Reinstall visibility mirrors the card's combined admin/tenant rule, and
  // the same rule the "Reinstall required" issue is raised under: an installs
  // admin who does not own the connection used to be told to reinstall and
  // then found no button anywhere.
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
  const alertingConnectionIds = new Set(
    issues
      .filter(
        (i) => i.kind === "needs-reauth" || i.kind === "reinstall-required",
      )
      .map((i) => i.serverId),
  );
  const alertingConnections = allServersForCatalog.filter((s) =>
    alertingConnectionIds.has(s.id),
  );
  const removableConnection =
    alertingConnections.length === 1 &&
    canFixInstall({ server: alertingConnections[0], viewer })
      ? alertingConnections[0]
      : null;
  const reauthConnections = allServersForCatalog.filter((s) =>
    issues.some((i) => i.kind === "needs-reauth" && i.serverId === s.id),
  );
  const mutableConnection =
    reauthConnections.length === 1 ? reauthConnections[0] : null;
  const mutedReauth = issues.find((i) => i.kind === "needs-reauth" && i.muted);

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

  const actions: TableRowAction[] = [];
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
  if (canEditCatalog) {
    actions.push({
      icon: <Pencil className="h-4 w-4" />,
      label: "Server settings",
      onClick: () => router.push(`/mcp/registry/${item.id}`),
    });
  }

  const dropdownActions: TableRowAction[] = [];
  if (!isBuiltin) {
    dropdownActions.push({
      icon: <Users className="h-4 w-4" />,
      label: "Manage credentials",
      href: `/mcp/registry/${item.id}?tab=credentials`,
    });
  }
  if (hasLocalInstalls) {
    dropdownActions.push({
      icon: <FileSearch className="h-4 w-4" />,
      label: "View logs",
      href: `/mcp/registry/${item.id}?tab=logs`,
    });
  }
  // Only re-authentication can be muted, so no other row offers it.
  if (mutedReauth) {
    const muted = allServersForCatalog.find(
      (s) => s.id === mutedReauth.serverId,
    );
    if (muted) {
      dropdownActions.push({
        icon: <Bell className="h-4 w-4" />,
        label: "Unmute this alert",
        onClick: () =>
          unmuteMutation.mutate({
            serverId: muted.id,
            serverName: muted.name,
            kind: "needs-reauth",
          }),
      });
    }
  } else if (mutableConnection) {
    dropdownActions.push({
      icon: <BellOff className="h-4 w-4" />,
      label: "Mute this alert",
      onClick: () => setMuteOpen(true),
    });
  }

  if (actions.length === 0 && dropdownActions.length === 0) return null;

  return (
    <>
      <div className="flex justify-end">
        <TableRowActions
          actions={actions}
          dropdownActions={
            dropdownActions.length > 0 ? dropdownActions : undefined
          }
        />
      </div>

      <UninstallServerDialog
        open={uninstallOpen}
        onClose={() => setUninstallOpen(false)}
        installs={uninstallInstalls}
        isCancelingInstallation={isInstalling}
        onCancelInstallation={onCancelInstallation}
      />

      <MuteAlertDialog
        open={muteOpen}
        onClose={() => setMuteOpen(false)}
        server={mutableConnection}
        kind="needs-reauth"
      />
    </>
  );
}

// === internal helpers ===

/**
 * What an installed server's Status cell says when it has no outstanding
 * issue. The feed's own state decides, never the absence of an entry: on a
 * deployment without Kubernetes no entry will ever arrive, and on one with it
 * the first entries arrive a moment after the page does.
 *
 * The words come from `getDeploymentLabel` over the same summary the card
 * builds, so the two views cannot describe one pod differently. Reading only
 * `state === "running"` called every other reported state "Status unavailable"
 * — including "Hibernated", which is the healthy steady state of an idle
 * server, and "Succeeded", which is a Job that finished and is still serving.
 * "Status unavailable" is reserved for a feed that has nothing to say.
 */
function installedStatusLabel({
  isLocal,
  feedState,
  serverId,
  deploymentStatuses,
}: {
  isLocal: boolean;
  feedState: McpDeploymentFeedState;
  serverId: string;
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
}): string {
  // A remote server has no pod, so "Installed" is the whole runtime story.
  if (!isLocal || feedState === "disabled") return "Installed";
  if (feedState === "loading") return "Checking…";
  const summary =
    feedState === "ready"
      ? computeDeploymentStatusSummary([serverId], deploymentStatuses)
      : null;
  if (summary) return getDeploymentLabel(summary.overallState);
  return "Status unavailable";
}

// Plain-text variant of LOCAL_MCP_DISABLED_MESSAGE (the shared const is JSX
// with a docs link; tooltips on table action buttons only take strings).
const LOCAL_MCP_DISABLED_TOOLTIP =
  "Unable to connect to Kubernetes cluster. Ensure K8s is running and the orchestrator configuration is correct.";

/**
 * " (3)" when an action applies to only part of the selection, so each button
 * says which part rather than both claiming the whole count.
 */
function countSuffix(applicable: number, selected: number): string {
  return applicable > 0 && applicable < selected ? ` (${applicable})` : "";
}
