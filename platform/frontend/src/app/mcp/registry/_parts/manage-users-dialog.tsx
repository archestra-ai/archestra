"use client";

import {
  ADMIN_ROLE_NAME,
  type archestraApiTypes,
  DocsPage,
  E2eTestId,
  getDocsUrl,
  isPlaywrightCatalogItem,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import { format } from "date-fns";
import {
  AlertTriangle,
  Building2,
  Check,
  ChevronsUpDown,
  Plus,
  RefreshCw,
  Trash,
  Trash2,
  User,
  UserRound,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useUpdateInternalMcpCatalogItem } from "@/lib/mcp/internal-mcp-catalog.query";
import { useInternalMcpCatalogItem } from "@/lib/mcp/mcp-registry.query";
import { useDeleteMcpServer, useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useCanReauthenticate } from "@/lib/mcp/use-can-reauthenticate";
import { useMyTeams } from "@/lib/teams/team.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { AddServiceAccountDialog } from "./add-service-account-dialog";
import { useCanModifyCatalogItem } from "./catalog-edit-access";
import {
  type DeploymentState,
  DeploymentStatusDot,
  getDeploymentLabel,
  STATE_PRIORITY,
} from "./deployment-status";
import { getLocalInstallationCopy } from "./local-installation-copy";
import { UninstallServerDialog } from "./uninstall-server-dialog";

type InstalledServer = archestraApiTypes.GetMcpServersResponses["200"][number];

interface ManageUsersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  label?: string;
  catalogId: string;
  /** Called when user wants to add a personal connection. */
  onAddPersonalConnection?: () => void;
  /** Called when user wants to add a team connection for a specific team */
  onAddSharedConnection?: (teamId: string) => void;
  /** Called when user wants to add an organization-wide connection */
  onAddOrgConnection?: () => void;
  /** Deployment statuses keyed by server ID */
  deploymentStatuses?: Record<string, McpDeploymentStatusEntry>;
  /** Called when user clicks a pod name to open the debug dialog */
  onOpenPodLogs?: (serverId: string) => void;
}

export function ManageUsersDialog({
  isOpen,
  onClose,
  label,
  catalogId,
  onAddPersonalConnection,
  onAddSharedConnection,
  onAddOrgConnection,
  deploymentStatuses = {},
  onOpenPodLogs,
}: ManageUsersDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="max-w-5xl h-[85vh] flex flex-col overflow-y-auto"
        data-testid={E2eTestId.ManageCredentialsDialog}
      >
        <ManageUsersContent
          isActive={isOpen}
          onClose={onClose}
          label={label}
          catalogId={catalogId}
          onAddPersonalConnection={onAddPersonalConnection}
          onAddSharedConnection={onAddSharedConnection}
          onAddOrgConnection={onAddOrgConnection}
          deploymentStatuses={deploymentStatuses}
          onOpenPodLogs={onOpenPodLogs}
        />
      </DialogContent>
    </Dialog>
  );
}

interface ManageUsersContentProps {
  isActive: boolean;
  onClose: () => void;
  label?: string;
  catalogId: string;
  onAddPersonalConnection?: () => void;
  onAddSharedConnection?: (teamId: string) => void;
  onAddOrgConnection?: () => void;
  deploymentStatuses?: Record<string, McpDeploymentStatusEntry>;
  onOpenPodLogs?: (serverId: string) => void;
  hideHeader?: boolean;
  bodyTestId?: string;
  /** Whether this catalog is currently being installed. */
  isInstalling?: boolean;
  onReauthenticate?: (server: InstalledServer) => void;
  /**
   * The server is shared with nobody, so the viewer's own installation is
   * the only one that matters: render it as one compact row instead of the
   * tables. The caller decides, because it needs the item's grants.
   */
  personalOnly?: boolean;
}

export function ManageUsersContent({
  isActive,
  onClose,
  label,
  catalogId,
  onAddPersonalConnection,
  onAddSharedConnection,
  onAddOrgConnection,
  deploymentStatuses = {},
  onOpenPodLogs,
  hideHeader = false,
  bodyTestId,
  isInstalling = false,
  onReauthenticate,
  personalOnly = false,
}: ManageUsersContentProps) {
  const router = useRouter();
  // This catalog item's installs, narrowed on the server, and the item itself
  // by id: neither needs the organization's full lists.
  const { data: allServersUnfiltered = [], isFetched: serversFetched } =
    useMcpServers({ includeAssignedAgents: false, catalogId });
  const { data: catalogItemById } = useInternalMcpCatalogItem(catalogId);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  // Get user's teams and permissions for re-authentication checks
  const { data: userTeams } = useMyTeams();
  const { data: hasMcpServerCreatePermission } = useHasPermissions({
    mcpServerInstallation: ["create"],
  });
  const { data: hasMcpServerUpdatePermission } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  const { data: hasMcpServerAdminPermission } = useHasPermissions(
    { mcpRegistry: ["update"] },
    "*",
  );

  const allServers = allServersUnfiltered.filter(
    (s) => s.catalogId === catalogId,
  );

  const [serviceAccountDialogOpen, setServiceAccountDialogOpen] =
    useState(false);

  // Use the first server for display purposes
  const firstServer = allServers?.[0];

  // The catalog item for connection labels and add-connection behavior.
  const catalogItem = catalogItemById ?? undefined;

  const canReauthenticate = useCanReauthenticate();

  // Get tooltip message for disabled re-authenticate button
  const getReauthTooltip = (mcpServer: (typeof allServers)[number]): string => {
    if (!hasMcpServerCreatePermission) {
      return "You need MCP server create permission to re-authenticate";
    }
    const scope = resolveServerScope(mcpServer);
    if (scope === "org") {
      return "Only an organization admin can re-authenticate an organization connection";
    }
    if (scope === "personal") {
      return "Only the connection owner can re-authenticate";
    }
    // WHY: Different messages for different failure reasons
    if (!hasMcpServerUpdatePermission) {
      return "You don't have permission to re-authenticate team connections";
    }
    return "You can only re-authenticate connections for teams you are a member of";
  };

  // Check if user can revoke (delete) a credential. Mirrors the backend's
  // assertScopedLifecycleAuthorization:
  // Personal: owner OR mcpServer:update. Team: installation admin OR team
  // admin role OR (mcpServer:update AND membership). Org: installation admin.
  const canRevoke = (mcpServer: (typeof allServers)[number]) => {
    const scope = resolveServerScope(mcpServer);
    if (scope === "org") return !!hasMcpServerAdminPermission;
    if (scope === "personal") {
      return (
        mcpServer.ownerId === currentUserId || !!hasMcpServerUpdatePermission
      );
    }
    if (hasMcpServerAdminPermission) return true;
    if (isCurrentUserTeamAdmin(mcpServer.teamId)) return true;
    if (!hasMcpServerUpdatePermission) return false;
    return userTeams?.some((team) => team.id === mcpServer.teamId) ?? false;
  };

  const isCurrentUserTeamAdmin = (teamId: string | null | undefined) => {
    if (!teamId || !currentUserId) return false;
    const team = userTeams?.find((team) => team.id === teamId);
    return team?.myRole === ADMIN_ROLE_NAME;
  };

  // Get tooltip message for disabled revoke button
  const getRevokeTooltip = (mcpServer: (typeof allServers)[number]): string => {
    const scope = resolveServerScope(mcpServer);
    if (scope === "org") {
      return "Only an organization admin can revoke an organization connection";
    }
    if (scope === "personal") {
      return "Only the connection owner or an editor/admin can revoke";
    }
    if (!hasMcpServerUpdatePermission) {
      return "You don't have permission to revoke team connections";
    }
    return "You can only revoke connections for teams you are a member of";
  };

  const deleteMcpServerMutation = useDeleteMcpServer();
  const [uninstallTarget, setUninstallTarget] = useState<
    (typeof allServers)[number] | null
  >(null);

  const handleRevoke = async (mcpServer: (typeof allServers)[number]) => {
    // A team or organization connection serves everyone who resolves to it,
    // so removing one is confirmed against the agents it affects first.
    if (resolveServerScope(mcpServer) !== "personal") {
      setUninstallTarget(mcpServer);
      return;
    }
    await deleteMcpServerMutation.mutateAsync({
      id: mcpServer.id,
      name: mcpServer.name,
    });
  };

  const handleReauthenticate = (mcpServer: (typeof allServers)[number]) => {
    if (onReauthenticate) {
      onReauthenticate(mcpServer);
      return;
    }
    const params = new URLSearchParams({
      [MCP_CATALOG_REAUTH_QUERY_PARAM]: catalogId,
      [MCP_CATALOG_SERVER_QUERY_PARAM]: mcpServer.id,
    });
    // The registry owns the complete reauth flow. It handles pure OAuth,
    // OAuth plus setup fields, and non-OAuth credentials without this table
    // guessing from catalog metadata.
    router.push(`/mcp/registry?${params.toString()}`);
  };

  // Close dialog when all credentials are revoked (only after data has loaded),
  // but keep it open if add callbacks are available.
  const hasAddCallbacks =
    !!onAddPersonalConnection ||
    !!onAddSharedConnection ||
    !!onAddOrgConnection;
  useEffect(() => {
    if (isActive && serversFetched && !firstServer && !hasAddCallbacks) {
      onClose();
    }
  }, [isActive, serversFetched, firstServer, onClose, hasAddCallbacks]);

  if (!firstServer && !hasAddCallbacks) {
    return null;
  }

  type Server = (typeof allServers)[number];
  function splitByScope(servers: Server[]) {
    const teamServers = servers.filter(
      (s) => resolveServerScope(s) === "team" && !!s.teamId,
    );
    const orgServers = servers.filter((s) => resolveServerScope(s) === "org");
    const teamsWithConnection = new Set(teamServers.map((s) => s.teamId));
    const myPersonalServer =
      servers.find(
        (s) =>
          resolveServerScope(s) === "personal" && s.ownerId === currentUserId,
      ) ?? null;
    const otherPersonalServers = servers.filter(
      (s) =>
        resolveServerScope(s) === "personal" && s.ownerId !== currentUserId,
    );
    const availableTeamsForShared =
      userTeams?.filter((t) => !teamsWithConnection.has(t.id)) ?? [];
    const hasOrgConnection = orgServers.length > 0;
    return {
      teamServers,
      orgServers,
      myPersonalServer,
      otherPersonalServers,
      availableTeamsForShared,
      hasOrgConnection,
    };
  }

  const getCredentialOwnerName = (mcpServer: Server): string => {
    const scope = resolveServerScope(mcpServer);
    if (scope === "org") return "Organization";
    if (scope === "team") return mcpServer.teamDetails?.name || "Team";
    return mcpServer.ownerEmail || "Deleted user";
  };

  const split = splitByScope(allServers);
  const canonicalStateByPod = computeCanonicalStateByPod(
    allServers,
    deploymentStatuses,
  );

  const personalRows: ConnectionRow[] = [
    ...(split.myPersonalServer
      ? [{ server: split.myPersonalServer, isYou: true } as const]
      : []),
    ...split.otherPersonalServers.map((s) => ({ server: s, isYou: false })),
  ];
  const serviceAccountRows: ConnectionRow[] = [
    ...split.teamServers.map((s) => ({ server: s, isYou: false })),
    ...split.orgServers.map((s) => ({ server: s, isYou: false })),
  ];

  const canAddPersonal =
    hasAddCallbacks && !!onAddPersonalConnection && !split.myPersonalServer;
  const canAddTeam =
    hasAddCallbacks &&
    !!onAddSharedConnection &&
    split.availableTeamsForShared.length > 0;
  const canAddOrg =
    hasAddCallbacks &&
    !!onAddOrgConnection &&
    !split.hasOrgConnection &&
    !!hasMcpServerAdminPermission;
  const isLocalServer = catalogItem?.serverType === "local";
  const installationCopy = getLocalInstallationCopy(
    catalogItem?.multitenant === true,
  );
  const isPersonalOnly =
    catalogItem != null && isPlaywrightCatalogItem(catalogItem.id);
  const canAddServiceAccount = !isPersonalOnly && (canAddTeam || canAddOrg);
  // Without installation update permission the backend refuses team and
  // organization installs, and shared credentials are not the viewer's to
  // pick or inspect, so the view keeps only their own installations.
  const isMemberView = !hasMcpServerUpdatePermission;
  // "for me" only tells a personal install apart from a shared one; in a
  // member's view, where their own is the only kind listed, it says nothing.
  const personalAddLabel = isLocalServer
    ? isMemberView
      ? "Install"
      : "Install for me"
    : "Connect my account";

  const showPersonalGroup = personalRows.length > 0 || canAddPersonal;
  const showSharedGroup =
    !isMemberView && (serviceAccountRows.length > 0 || canAddServiceAccount);

  const rowProps: RowRenderProps = {
    deploymentStatuses,
    canonicalStateByPod,
    getCredentialOwnerName,
    canReauthenticate,
    getReauthTooltip,
    canRevoke,
    getRevokeTooltip,
    handleReauthenticate,
    handleRevoke,
    isDeleting: deleteMcpServerMutation.isPending,
    onOpenPodLogs,
    showInfrastructure: !isMemberView,
  };

  return (
    <>
      {!hideHeader && (
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Connections
            <span className="text-muted-foreground font-normal">
              {label || firstServer?.name}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">Connections</DialogDescription>
        </DialogHeader>
      )}

      <div
        className={hideHeader ? "space-y-6" : "space-y-6 pb-4"}
        data-testid={bodyTestId}
      >
        {personalOnly ? (
          <OwnConnectionRow
            server={split.myPersonalServer}
            isLocalServer={isLocalServer}
            deploymentState={(() => {
              const status =
                split.myPersonalServer &&
                deploymentStatuses[split.myPersonalServer.id];
              return status
                ? resolveDeploymentState(status, canonicalStateByPod)
                : null;
            })()}
            installAction={
              onAddPersonalConnection ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isInstalling}
                  onClick={() => onAddPersonalConnection()}
                >
                  <Plus className="h-4 w-4" />
                  <span>
                    {isInstalling ? "Installing..." : personalAddLabel}
                  </span>
                </Button>
              ) : null
            }
            canReauthenticate={canReauthenticate}
            getReauthTooltip={getReauthTooltip}
            onReauthenticate={handleReauthenticate}
            onUninstall={setUninstallTarget}
            isDeleting={deleteMcpServerMutation.isPending}
          />
        ) : null}

        {!personalOnly &&
          !isMemberView &&
          catalogItem?.serverType === "remote" && (
            <AgentConnectionsSection
              item={catalogItem}
              connections={allServers}
            />
          )}

        {!personalOnly && (showPersonalGroup || showSharedGroup) && (
          <ConnectionsTable
            noun={isLocalServer ? "installation" : "credential"}
            personal={
              showPersonalGroup
                ? {
                    title: isLocalServer
                      ? "Personal installations"
                      : "Personal connections",
                    description: isLocalServer
                      ? installationCopy.personal
                      : "Private to its owner — only that person can use it.",
                    emptyText: isLocalServer
                      ? "No personal installations yet."
                      : "No personal connections yet.",
                    rows: personalRows,
                    testId: E2eTestId.ManageCredentialsDialogTable,
                    add: canAddPersonal ? (
                      <GroupAddButton
                        disabled={isInstalling}
                        onClick={() => {
                          onClose();
                          onAddPersonalConnection?.();
                        }}
                      >
                        {isInstalling ? "Installing..." : personalAddLabel}
                      </GroupAddButton>
                    ) : null,
                  }
                : null
            }
            shared={
              showSharedGroup
                ? {
                    title: isLocalServer
                      ? "Shared installations"
                      : "Service accounts",
                    description: isLocalServer
                      ? installationCopy.shared
                      : "Static credentials intentionally shared with a team or organization.",
                    emptyText: isLocalServer
                      ? "No shared installations yet."
                      : "No service accounts yet.",
                    rows: serviceAccountRows,
                    testId: E2eTestId.ManageServiceAccountsTable,
                    add: canAddServiceAccount ? (
                      <GroupAddButton
                        disabled={isInstalling}
                        testId={
                          E2eTestId.ManageCredentialsAddServiceAccountButton
                        }
                        onClick={() => setServiceAccountDialogOpen(true)}
                      >
                        {isLocalServer
                          ? "Add shared installation"
                          : "Add service account"}
                      </GroupAddButton>
                    ) : null,
                  }
                : null
            }
            {...rowProps}
          />
        )}
      </div>

      <AddServiceAccountDialog
        open={serviceAccountDialogOpen}
        onOpenChange={setServiceAccountDialogOpen}
        availableTeams={canAddTeam ? split.availableTeamsForShared : []}
        canAddOrg={canAddOrg}
        resourceKind={isLocalServer ? "installation" : "service-account"}
        onConfirm={(target) => {
          onClose();
          if (target.type === "org") {
            onAddOrgConnection?.();
          } else {
            onAddSharedConnection?.(target.teamId);
          }
        }}
      />

      <UninstallServerDialog
        open={!!uninstallTarget}
        onClose={() => setUninstallTarget(null)}
        installs={
          uninstallTarget
            ? [
                {
                  server: {
                    id: uninstallTarget.id,
                    name: uninstallTarget.name,
                    scope: uninstallTarget.scope,
                    teamId: uninstallTarget.teamId,
                  },
                },
              ]
            : []
        }
      />

      {!hideHeader && (
        <DialogStickyFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogStickyFooter>
      )}
    </>
  );
}

type ServerEntry = NonNullable<
  ReturnType<typeof useMcpServers>["data"]
>[number];

type ConnectionRow = { server: ServerEntry; isYou: boolean };

interface RowRenderProps {
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  canonicalStateByPod: Map<string, string>;
  getCredentialOwnerName: (s: ServerEntry) => string;
  canReauthenticate: (s: ServerEntry) => boolean;
  getReauthTooltip: (s: ServerEntry) => string;
  canRevoke: (s: ServerEntry) => boolean;
  getRevokeTooltip: (s: ServerEntry) => string;
  handleReauthenticate: (s: ServerEntry) => void;
  handleRevoke: (s: ServerEntry) => void;
  isDeleting: boolean;
  onOpenPodLogs?: (serverId: string) => void;
  /** The Pod column, for those who manage installations. */
  showInfrastructure: boolean;
}

interface ConnectionGroup {
  title: string;
  description: string;
  emptyText: string;
  rows: ConnectionRow[];
  testId: string;
  /** The group's add action, at the right of its header row. */
  add: React.ReactNode;
}

/**
 * Every credential in one table: a summary line, then a group per kind
 * (personal, then shared), each opened by a header row that names it and holds
 * its add action. Scope reads from the avatar, so there is no scope column, and
 * the date and creator share a meta line under the owner.
 */
function ConnectionsTable({
  noun,
  personal,
  shared,
  ...rowProps
}: {
  noun: "credential" | "installation";
  personal: ConnectionGroup | null;
  shared: ConnectionGroup | null;
} & RowRenderProps) {
  const groups = [personal, shared].filter(
    (group): group is ConnectionGroup => group !== null,
  );
  const allRows = groups.flatMap((group) => group.rows);
  const showPod =
    rowProps.showInfrastructure &&
    allRows.some((row) => rowProps.deploymentStatuses[row.server.id]);
  const needSignIn = allRows.filter((row) => row.server.oauthRefreshError);
  const grouped = groups.length > 1;
  const columnCount = showPod ? 3 : 2;

  return (
    <TooltipProvider>
      <div className="space-y-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span className="font-medium tabular-nums">
            {allRows.length} {allRows.length === 1 ? noun : `${noun}s`}
          </span>
          {grouped ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {personal?.rows.length} personal
              <span className="px-1 text-muted-foreground/50">·</span>
              {shared?.rows.length} shared
            </span>
          ) : null}
          {needSignIn.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 tabular-nums dark:text-amber-500">
              <span className="size-1.5 rounded-full bg-current" />
              {needSignIn.length} {needSignIn.length === 1 ? "needs" : "need"}{" "}
              sign-in
            </span>
          ) : null}
        </div>

        <div className="overflow-x-auto rounded-lg border">
          {/* Only the Pod column needs a floor width; without it the owner
              cell wraps and the table fits a phone. */}
          <Table className={showPod ? "min-w-[640px]" : undefined}>
            <colgroup>
              <col />
              {showPod ? <col className="w-[34%]" /> : null}
              <col className="w-[104px]" />
            </colgroup>
            <TableHeader className="bg-muted/30">
              <TableRow className="hover:bg-transparent">
                <ColumnHead>Owner</ColumnHead>
                {showPod ? <ColumnHead>Pod</ColumnHead> : null}
                <ColumnHead className="pr-4 text-right md:pr-4">
                  Actions
                </ColumnHead>
              </TableRow>
            </TableHeader>
            {groups.map((group) => (
              <ConnectionGroupRows
                key={group.testId}
                group={group}
                showTitle={grouped}
                showPod={showPod}
                columnCount={columnCount}
                {...rowProps}
              />
            ))}
          </Table>
        </div>
      </div>
    </TooltipProvider>
  );
}

/** A link-weight add action for a group's header row. */
function GroupAddButton({
  children,
  onClick,
  disabled,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="-mr-1.5 h-6 shrink-0 gap-1 px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
    >
      <Plus className="size-3.5" />
      {children}
    </Button>
  );
}

function ColumnHead({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <TableHead
      className={cn(
        "h-8 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

function ConnectionGroupRows({
  group,
  showTitle,
  showPod,
  columnCount,
  ...rowProps
}: {
  group: ConnectionGroup;
  /** False when the group is the only one: the section title names it. */
  showTitle: boolean;
  showPod: boolean;
  columnCount: number;
} & RowRenderProps) {
  return (
    <TableBody
      data-testid={group.testId}
      className="border-b last:border-b-0 [&_tr:last-child]:border-0"
    >
      {showTitle || group.add ? (
        <TableRow className="border-b bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={columnCount} className="h-8 py-0">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                {showTitle ? (
                  <>
                    <span className="shrink-0 text-xs font-medium">
                      {group.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {group.rows.length}
                    </span>
                  </>
                ) : null}
                <span
                  className="min-w-0 truncate text-xs text-muted-foreground max-sm:hidden"
                  title={group.description}
                >
                  {group.description}
                </span>
              </div>
              {group.add}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
      {group.rows.length === 0 ? (
        <TableRow className="hover:bg-transparent">
          <TableCell
            colSpan={columnCount}
            className="h-11 py-0 text-sm text-muted-foreground"
          >
            {group.emptyText}
          </TableCell>
        </TableRow>
      ) : (
        group.rows.map((row) => (
          <ConnectionTableRow
            key={row.server.id}
            row={row}
            showPod={showPod}
            {...rowProps}
          />
        ))
      )}
    </TableBody>
  );
}

function ConnectionTableRow({
  row: { server, isYou },
  showPod,
  deploymentStatuses,
  canonicalStateByPod,
  getCredentialOwnerName,
  canReauthenticate,
  getReauthTooltip,
  canRevoke,
  getRevokeTooltip,
  handleReauthenticate,
  handleRevoke,
  isDeleting,
  onOpenPodLogs,
}: {
  row: ConnectionRow;
  showPod: boolean;
} & RowRenderProps) {
  const owner = getCredentialOwnerName(server);
  const scope = resolveServerScope(server);
  const needsSignIn = Boolean(server.oauthRefreshError);
  const createdBy = scope !== "personal" ? (server.ownerEmail ?? null) : null;

  const actions: TableRowAction[] = [];
  if (needsSignIn) {
    actions.push({
      icon: <RefreshCw className="size-4" />,
      label: "Re-authenticate",
      onClick: () => handleReauthenticate(server),
      disabled: !canReauthenticate(server),
      disabledTooltip: getReauthTooltip(server),
    });
  }
  actions.push({
    icon: <Trash2 className="size-4" />,
    label: "Revoke",
    variant: "destructive",
    onClick: () => handleRevoke(server),
    disabled: isDeleting || !canRevoke(server),
    disabledTooltip: canRevoke(server) ? undefined : getRevokeTooltip(server),
    testId: isYou
      ? `${E2eTestId.RevokeCredentialButton}-personal`
      : `${E2eTestId.RevokeCredentialButton}-${owner}`,
  });

  return (
    <TableRow
      data-testid={E2eTestId.CredentialRow}
      data-server-id={server.id}
      className={cn("h-11", needsSignIn && "bg-amber-500/[0.04]")}
    >
      <TableCell className="relative py-1.5">
        {needsSignIn ? (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-0.5 bg-amber-500"
          />
        ) : null}
        <div className="flex min-w-0 items-center gap-2.5">
          <ScopeAvatar owner={owner} server={server} />
          <div className="min-w-0 flex-1 leading-4">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-1">
              <span
                className="min-w-0 text-[13px] font-medium [overflow-wrap:anywhere]"
                data-testid={E2eTestId.CredentialOwner}
              >
                {owner}
              </span>
              {isYou ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  (you)
                </span>
              ) : null}
            </div>
            <ConnectionMeta
              createdAt={server.createdAt}
              createdBy={createdBy}
              needsSignIn={needsSignIn}
            />
          </div>
        </div>
      </TableCell>
      {showPod ? (
        <TableCell className="max-w-[260px] py-0">
          <PodCell
            server={server}
            deploymentStatuses={deploymentStatuses}
            canonicalStateByPod={canonicalStateByPod}
            onOpenPodLogs={onOpenPodLogs}
          />
        </TableCell>
      ) : null}
      <TableCell className="py-0 pr-4 md:pr-4">
        <div className="flex justify-end">
          <TableRowActions actions={actions} itemName={owner} />
        </div>
      </TableCell>
    </TableRow>
  );
}

function PodCell({
  server,
  deploymentStatuses,
  canonicalStateByPod,
  onOpenPodLogs,
}: {
  server: ServerEntry;
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  canonicalStateByPod: Map<string, string>;
  onOpenPodLogs?: (serverId: string) => void;
}) {
  const status = deploymentStatuses[server.id];
  if (!status) {
    return <span className="text-muted-foreground">—</span>;
  }
  const podName = status.podName;
  const effectiveState = resolveDeploymentState(status, canonicalStateByPod);
  const dot = <DeploymentStatusDot state={effectiveState} />;
  if (!podName) {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // An idle-scaled deployment has no pod BY DESIGN — naming
    // its state beats a placeholder that reads like telemetry
    // went missing.
    // SPDX-SnippetEnd
    return (
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground italic">
        {dot}
        <span>
          {
            /* SPDX-SnippetBegin */
            /* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */
            /* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */
            effectiveState === "hibernated" || effectiveState === "waking"
              ? getDeploymentLabel(effectiveState)
              : /* SPDX-SnippetEnd */ "Pod not reported yet"
          }
        </span>
      </div>
    );
  }
  return (
    <UnstyledButton
      type="button"
      onClick={() => onOpenPodLogs?.(server.id)}
      className="flex w-full items-center gap-1.5 text-sm hover:underline cursor-pointer font-mono min-w-0"
    >
      {dot}
      <span className="truncate min-w-0 flex-1 text-left">{podName}</span>
    </UnstyledButton>
  );
}

/** "Sign-in expired · Added 4 days ago · by mark@example.com", wrapping as needed. */
function ConnectionMeta({
  createdAt,
  createdBy,
  needsSignIn,
}: {
  createdAt: string;
  createdBy: string | null;
  needsSignIn: boolean;
}) {
  const created = new Date(createdAt);
  const dot = <span className="px-1 text-muted-foreground/50">·</span>;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline text-[11px] text-muted-foreground tabular-nums">
      {needsSignIn ? (
        <>
          <span className="font-medium text-amber-600 dark:text-amber-500">
            Needs re-authentication
          </span>
          {dot}
        </>
      ) : null}
      <span className="whitespace-nowrap" title={format(created, "PPpp")}>
        Added{" "}
        {formatRelativeTimeFromNow(created, { strict: true, neverLabel: "—" })}
      </span>
      {createdBy ? (
        <>
          {dot}
          <span
            className="min-w-0 [overflow-wrap:anywhere]"
            title={`Created by ${createdBy}`}
          >
            by <span className="font-mono">{createdBy}</span>
          </span>
        </>
      ) : null}
    </div>
  );
}

/**
 * Scope without a column: a round initials avatar is a person; a square tile
 * with a glyph is a team or the whole organization.
 */
function ScopeAvatar({
  owner,
  server,
}: {
  owner: string;
  server: ServerEntry;
}) {
  const scope = resolveServerScope(server);
  const shared = scope !== "personal";
  const teamName = server.teamDetails?.name;
  const label =
    scope === "personal"
      ? "Personal credential"
      : scope === "team"
        ? `Team service account${teamName ? ` — ${teamName}` : ""}`
        : "Organization service account";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={label} className="shrink-0 cursor-default">
          <Avatar className={cn("size-7", shared && "rounded-md")}>
            <AvatarFallback
              className={cn(
                "text-[10px] font-medium text-muted-foreground",
                shared && "rounded-md border bg-background",
              )}
            >
              {scope === "team" ? (
                <Users className="size-3.5" />
              ) : scope === "org" ? (
                <Building2 className="size-3.5" />
              ) : (
                initialsOf(owner)
              )}
            </AvatarFallback>
          </Avatar>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The viewer's own installation or connection of a server shared with nobody
 * else, as one line: its state and date with its actions, or "Not installed"
 * with the install action.
 */
function OwnConnectionRow({
  server,
  isLocalServer,
  deploymentState,
  installAction,
  canReauthenticate,
  getReauthTooltip,
  onReauthenticate,
  onUninstall,
  isDeleting,
}: {
  server: ServerEntry | null;
  isLocalServer: boolean;
  /** The pod's reported state; null when none has been reported. */
  deploymentState: DeploymentState | null;
  installAction: React.ReactNode;
  canReauthenticate: (s: ServerEntry) => boolean;
  getReauthTooltip: (s: ServerEntry) => string;
  onReauthenticate: (s: ServerEntry) => void;
  onUninstall: (s: ServerEntry) => void;
  isDeleting: boolean;
}) {
  if (!server) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
        <span className="text-sm text-muted-foreground">
          {isLocalServer ? "Not installed" : "Not connected"}
        </span>
        {installAction}
      </div>
    );
  }

  const createdAt = new Date(server.createdAt);
  // A status of its own only when it says more than the date line does: the
  // pod's state, or a rejected token.
  const statusLabel = server.oauthRefreshError
    ? "Needs re-authentication"
    : isLocalServer && deploymentState
      ? getDeploymentLabel(deploymentState)
      : null;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
      data-testid={E2eTestId.CredentialRow}
      data-server-id={server.id}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {statusLabel ? (
          <>
            {isLocalServer && deploymentState && !server.oauthRefreshError ? (
              <DeploymentStatusDot state={deploymentState} />
            ) : null}
            <span className="font-medium">{statusLabel}</span>
          </>
        ) : null}
        <span
          className={cn(
            "whitespace-nowrap",
            statusLabel && "text-muted-foreground",
          )}
          title={format(createdAt, "PPpp")}
        >
          {`${isLocalServer ? "Installed" : "Connected"} ${format(createdAt, "PP")}`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {server.oauthRefreshError && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    onClick={() => onReauthenticate(server)}
                    disabled={!canReauthenticate(server)}
                    size="sm"
                    variant="outline"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Re-authenticate
                  </Button>
                </span>
              </TooltipTrigger>
              {!canReauthenticate(server) && (
                <TooltipContent>{getReauthTooltip(server)}</TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        )}
        <Button
          onClick={() => onUninstall(server)}
          disabled={isDeleting}
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          data-testid={`${E2eTestId.RevokeCredentialButton}-personal`}
        >
          <Trash className="h-4 w-4" />
          Uninstall
        </Button>
      </div>
    </div>
  );
}

/**
 * The state a pod's dot and label show. Multi-tenant rows share one pod, so
 * the canonical state wins; pods that never needed creating count as running.
 */
function resolveDeploymentState(
  status: McpDeploymentStatusEntry,
  canonicalStateByPod: Map<string, string>,
): DeploymentState {
  const state =
    (status.podName && canonicalStateByPod.get(status.podName)) || status.state;
  return (
    state === "not_created" || state === "succeeded" ? "running" : state
  ) as DeploymentState;
}

// `scope` is nullable on rows created before it existed; a team id implies a
// team connection, and everything else without a scope is personal.
function resolveServerScope(server: ServerEntry): "personal" | "team" | "org" {
  return server.scope ?? (server.teamId ? "team" : "personal");
}

// Multi-tenant catalogs alias one pod across N caller rows. Each row's
// K8sDeployment instance tracks its own state independently, so the row that
// didn't observe the pod first stays "pending" while the other goes "failed".
// Pick a canonical state per podName (across every connection for the catalog,
// so the personal and service-account tables agree) so all rows match.
function computeCanonicalStateByPod(
  servers: ServerEntry[],
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>,
): Map<string, string> {
  const canonicalStateByPod = new Map<string, string>();
  for (const server of servers) {
    const entry = deploymentStatuses[server.id];
    if (!entry?.podName) continue;
    const current = canonicalStateByPod.get(entry.podName);
    if (
      !current ||
      (STATE_PRIORITY[entry.state] ?? 0) > (STATE_PRIORITY[current] ?? 0)
    ) {
      canonicalStateByPod.set(entry.podName, entry.state);
    }
  }
  return canonicalStateByPod;
}

// The catalog-level "default credential" setting as one settings row: a title
// and description, and a value button that opens a searchable picker — "each
// caller's own account" first, then the service accounts by team and
// organization. It governs every tool assignment that resolves credentials at
// call time — Auto mode always, and Custom-mode assignments unless a specific
// connection is pinned on the assignment itself. NULL (default) = agents act
// on behalf of whoever is calling, using that person's own connection; an
// mcp_servers.id = agents always use that one connection. Saves on choice;
// gated by the same authorization as editing the catalog item.
function AgentConnectionsSection({
  item,
  connections,
}: {
  item: Pick<
    archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
    "id" | "effectiveActions" | "dynamicConnectionMcpServerId"
  >;
  connections: NonNullable<ReturnType<typeof useMcpServers>["data"]>;
}) {
  const { canModify } = useCanModifyCatalogItem(item);
  const updateMutation = useUpdateInternalMcpCatalogItem();
  const [open, setOpen] = useState(false);
  const teamAccounts = connections.filter(
    (connection) => resolveServerScope(connection) === "team",
  );
  const orgAccounts = connections.filter(
    (connection) => resolveServerScope(connection) === "org",
  );
  const pinnedId = item.dynamicConnectionMcpServerId ?? null;
  const pinned = pinnedId
    ? [...teamAccounts, ...orgAccounts].find(
        (connection) => connection.id === pinnedId,
      )
    : undefined;
  const pinUnresolved = Boolean(pinnedId) && !pinned;

  const choose = (value: string | null) => {
    setOpen(false);
    if (value === pinnedId) return;
    updateMutation.mutate({
      id: item.id,
      data: { dynamicConnectionMcpServerId: value },
    });
  };

  return (
    // Stacks by the width it is given, not the window's: the section sits
    // beside its own title column, so a wide window can still be narrow here.
    <div className="@container space-y-2">
      <div className="flex flex-col gap-3 @lg:flex-row @lg:items-center @lg:justify-between @lg:gap-6">
        <div className="min-w-0 space-y-0.5">
          <h4 className="text-sm font-medium">Agents connect with</h4>
          <p className="text-xs text-muted-foreground">
            The account agents sign in as when they call this server&apos;s
            tools.{" "}
            <ExternalDocsLink
              href={getDocsUrl(
                DocsPage.McpAuthentication,
                "resolve-at-call-time",
              )}
              className="underline underline-offset-2 hover:text-foreground"
              showIcon={false}
            >
              Learn more
            </ExternalDocsLink>
          </p>
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              role="combobox"
              aria-expanded={open}
              aria-label="Account agents connect with"
              disabled={!canModify || updateMutation.isPending}
              className={cn(
                "w-full shrink-0 justify-between gap-2 font-normal @lg:w-64",
                pinUnresolved &&
                  "border-amber-500/50 text-amber-700 dark:text-amber-400",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                {pinUnresolved ? (
                  <AlertTriangle className="size-3.5 shrink-0" />
                ) : pinned ? (
                  <ScopeGlyph server={pinned} />
                ) : (
                  <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">
                  {pinUnresolved
                    ? "Removed account"
                    : pinned
                      ? connectionAccountLabel(pinned)
                      : "Each caller's own account"}
                </span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <Command>
              <CommandInput placeholder="Search service accounts…" />
              <CommandList className="max-h-[320px]">
                <CommandGroup>
                  <CommandItem
                    value="__caller__"
                    forceMount
                    onSelect={() => choose(null)}
                    className="items-start gap-2.5 py-2"
                  >
                    <OptionGlyph>
                      <UserRound className="size-3.5" />
                    </OptionGlyph>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="font-medium">
                          Each caller&apos;s own account
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          Recommended
                        </span>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Falls back to a team or organization account
                      </span>
                    </span>
                    <SelectedMark on={!pinnedId} />
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator alwaysRender />
                {teamAccounts.length + orgAccounts.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-muted-foreground">
                    No service accounts yet. Add one to have every caller use
                    it.
                  </p>
                ) : (
                  <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
                    No matching service account.
                  </CommandEmpty>
                )}
                {[
                  { heading: "Teams", accounts: teamAccounts },
                  { heading: "Organization", accounts: orgAccounts },
                ].map(({ heading, accounts }) =>
                  accounts.length > 0 ? (
                    <CommandGroup key={heading} heading={heading}>
                      {accounts.map((connection) => (
                        <CommandItem
                          key={connection.id}
                          value={`${connectionAccountLabel(connection)} ${connection.id}`}
                          onSelect={() => choose(connection.id)}
                        >
                          <OptionGlyph>
                            <ScopeGlyph server={connection} />
                          </OptionGlyph>
                          <span className="min-w-0 flex-1 truncate">
                            {connectionAccountLabel(connection)}
                          </span>
                          {connection.oauthRefreshError ? (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500">
                              <span className="size-1.5 rounded-full bg-current" />
                              Sign-in expired
                            </span>
                          ) : null}
                          <SelectedMark on={pinnedId === connection.id} />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : null,
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      {pinUnresolved ? (
        <p className="flex items-center gap-1.5 text-xs text-amber-600 @lg:justify-end dark:text-amber-500">
          <AlertTriangle className="size-3.5 shrink-0" />
          The selected account was removed. Callers use their own until you
          choose another.
        </p>
      ) : null}
    </div>
  );
}

function connectionAccountLabel(connection: ServerEntry) {
  return resolveServerScope(connection) === "team"
    ? (connection.teamDetails?.name ?? "Unknown team")
    : "Organization account";
}

function ScopeGlyph({ server }: { server: ServerEntry }) {
  return resolveServerScope(server) === "team" ? (
    <Users className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
  );
}

function OptionGlyph({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
      {children}
    </span>
  );
}

function SelectedMark({ on }: { on: boolean }) {
  return (
    <Check
      className={cn(
        "ml-auto size-4 shrink-0",
        on ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

function initialsOf(name: string) {
  const local = name.split("@")[0] ?? name;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  const letters =
    parts.length > 1
      ? `${parts[0][0]}${parts[1][0]}`
      : (parts[0]?.slice(0, 1) ?? "?");
  return letters.toUpperCase();
}
