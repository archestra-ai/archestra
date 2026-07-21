"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
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
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useReinstallInternalMcpCatalogItem } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useCanModifyCatalogItem } from "./catalog-edit-access";
import { shouldShowMcpCardChatButton } from "./chat-button-visibility";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
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
  installingItemId,
  onInstall,
  onReinstall,
  onCancelInstallation,
}: McpServerTableProps) {
  const router = useRouter();

  const columns: ColumnDef<CatalogItem>[] = [
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
      header: "Author",
      cell: ({ row }) => (
        <span className="line-clamp-1 text-sm text-muted-foreground">
          {row.original.authorName ?? "—"}
        </span>
      ),
    },
    {
      id: "status",
      size: 140,
      header: "Status",
      cell: ({ row }) => {
        const item = row.original;
        const { installedServer, isInstallInProgress } = getServerInfo(item);
        if (installingItemId === item.id || isInstallInProgress) {
          return (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Installing…
            </span>
          );
        }
        if (item.serverType === "builtin") {
          return <Badge variant="secondary">Built-in</Badge>;
        }
        if (installedServer) {
          return <Badge variant="secondary">Installed</Badge>;
        }
        return (
          <span className="text-sm text-muted-foreground">Not installed</span>
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
    <DataTable
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      onRowClick={(row) => router.push(`/mcp/registry/${row.id}`)}
      emptyMessage="No MCP servers found."
      hidePaginationWhenSinglePage
    />
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
  isInstalling,
  onInstall,
  onReinstall,
  onCancelInstallation,
}: {
  item: CatalogItem;
  installedServer?: InstalledServer;
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

  // Reinstall visibility mirrors the card's combined admin/tenant rule.
  const userFlaggedInstalls = allServersForCatalog.filter(
    (s) => s.reinstallRequired && s.ownerId === currentUserId,
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

  // The most recent personal install, as on the card's uninstall dialog.
  const uninstallInstalls: UninstallServerInstall[] = (() => {
    const install = personalServersForCatalog
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];
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
    </>
  );
}

// === internal helpers ===

// Plain-text variant of LOCAL_MCP_DISABLED_MESSAGE (the shared const is JSX
// with a docs link; tooltips on table action buttons only take strings).
const LOCAL_MCP_DISABLED_TOOLTIP =
  "Unable to connect to Kubernetes cluster. Ensure K8s is running and the orchestrator configuration is correct.";
