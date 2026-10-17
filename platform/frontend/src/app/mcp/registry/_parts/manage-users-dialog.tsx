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
  Building2,
  Info,
  KeyRound,
  Plus,
  RefreshCw,
  Trash,
  Trash2,
  TriangleAlert,
  User,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyListState } from "@/components/empty-list-state";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  useInternalMcpCatalog,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useDeleteMcpServer, useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useCanReauthenticate } from "@/lib/mcp/use-can-reauthenticate";
import { useMyTeams } from "@/lib/teams/team.query";
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
  // Subscribe to live mcp-servers query to get fresh data. We fetch all
  // servers (no catalogId filter) and keep those installed from this catalog.
  const { data: allServersUnfiltered = [], isFetched: serversFetched } =
    useMcpServers({ includeAssignedAgents: false });
  const { data: catalogItems } = useInternalMcpCatalog({});
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

  // Find the catalog item for connection labels and add-connection behavior.
  const catalogItem = catalogItems?.find((item) => item.id === catalogId);

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
    return (
      team?.members?.some(
        (member) =>
          member.userId === currentUserId && member.role === ADMIN_ROLE_NAME,
      ) ?? false
    );
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

        {!personalOnly && (personalRows.length > 0 || canAddPersonal) && (
          <ConnectionsSection
            // Alone on a member's view, the block needs no heading: the
            // section title already names it.
            title={
              isMemberView
                ? undefined
                : isLocalServer
                  ? "Personal installations"
                  : "Personal connections"
            }
            description={
              isLocalServer
                ? installationCopy.personal
                : "Private to its owner — only that person can use it."
            }
            emptyText={
              isLocalServer
                ? "No personal installations yet."
                : "No personal connections yet."
            }
            rows={personalRows}
            tableTestId={E2eTestId.ManageCredentialsDialogTable}
            action={
              canAddPersonal ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isInstalling}
                  onClick={() => {
                    onClose();
                    onAddPersonalConnection?.();
                  }}
                >
                  <Plus className="h-4 w-4" />
                  {isInstalling ? "Installing..." : personalAddLabel}
                </Button>
              ) : null
            }
            {...rowProps}
          />
        )}

        {!personalOnly &&
          !isMemberView &&
          (serviceAccountRows.length > 0 || canAddServiceAccount) && (
            <ConnectionsSection
              title={
                isLocalServer ? "Shared installations" : "Service accounts"
              }
              description={
                isLocalServer
                  ? installationCopy.shared
                  : "Static credentials intentionally shared with a team or organization."
              }
              emptyText={
                isLocalServer
                  ? "No shared installations yet."
                  : "No service accounts yet."
              }
              rows={serviceAccountRows}
              tableTestId={E2eTestId.ManageServiceAccountsTable}
              action={
                canAddServiceAccount ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isInstalling}
                    data-testid={
                      E2eTestId.ManageCredentialsAddServiceAccountButton
                    }
                    onClick={() => setServiceAccountDialogOpen(true)}
                  >
                    <Plus className="h-4 w-4" />
                    {isLocalServer
                      ? "Add shared installation"
                      : "Add service account"}
                  </Button>
                ) : null
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

function ConnectionsSection({
  title,
  description,
  action,
  rows,
  emptyText,
  tableTestId,
  ...rowProps
}: {
  /** Omitted when the block is the only one in its section. */
  title?: string;
  description: string;
  action: React.ReactNode;
  rows: ConnectionRow[];
  emptyText: string;
  tableTestId: string;
} & RowRenderProps) {
  return (
    <section className="space-y-2">
      {title ? (
        <div className="flex items-center gap-1.5">
          <h4 className="text-sm font-medium">{title}</h4>
          {rows.length > 0 && (
            <span className="text-sm tabular-nums text-muted-foreground">
              {rows.length}
            </span>
          )}
          <InfoHint label={`About ${title.toLowerCase()}`}>
            {description}
          </InfoHint>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <>
          <div className="overflow-hidden rounded-lg border">
            <ConnectionsTable rows={rows} testId={tableTestId} {...rowProps} />
          </div>
          {action}
        </>
      ) : action ? (
        <EmptyListState message={emptyText} action={action} />
      ) : (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      )}
    </section>
  );
}

function ConnectionsTable({
  rows,
  testId,
  ...rowProps
}: {
  rows: ConnectionRow[];
  testId: string;
} & RowRenderProps) {
  const hasDeploymentStatuses =
    rowProps.showInfrastructure &&
    rows.some((r) => rowProps.deploymentStatuses[r.server.id]);

  return (
    // A fixed-layout table squeezes its unsized columns to nothing on a
    // narrow screen; a floor width makes it scroll sideways instead.
    <Table
      data-testid={testId}
      className={hasDeploymentStatuses ? "min-w-[620px]" : "min-w-[440px]"}
    >
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Owner</TableHead>
          {hasDeploymentStatuses && (
            <TableHead className="w-[34%]">Pod</TableHead>
          )}
          <TableHead className="w-[120px]">Added</TableHead>
          <TableHead className="w-[96px]">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <ConnectionTableRow
            key={row.server.id}
            row={row}
            showPod={hasDeploymentStatuses}
            {...rowProps}
          />
        ))}
      </TableBody>
    </Table>
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
  const createdBy = scope !== "personal" ? server.ownerEmail : null;
  const createdAt = new Date(server.createdAt);

  const actions: TableRowAction[] = [];
  if (server.oauthRefreshError) {
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
    <TableRow data-testid={E2eTestId.CredentialRow} data-server-id={server.id}>
      <TableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <OwnerAvatar owner={owner} scope={scope} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-1">
              <span
                className="truncate"
                data-testid={E2eTestId.CredentialOwner}
              >
                {owner}
              </span>
              {isYou && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  (you)
                </span>
              )}
            </div>
            {server.oauthRefreshError || createdBy ? (
              <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                {server.oauthRefreshError ? (
                  <span className="flex shrink-0 items-center gap-1 text-amber-600 dark:text-amber-500">
                    <span className="size-1.5 rounded-full bg-current" />
                    Needs re-authentication
                  </span>
                ) : null}
                {server.oauthRefreshError && createdBy ? (
                  <span aria-hidden="true">·</span>
                ) : null}
                {createdBy ? (
                  <span className="truncate" title={`Created by ${createdBy}`}>
                    {createdBy}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </TableCell>
      {showPod && (
        <TableCell className="max-w-[260px]">
          {(() => {
            const status = deploymentStatuses[server.id];
            if (!status) {
              return <span className="text-muted-foreground">—</span>;
            }
            const podName = status.podName;
            const effectiveState = resolveDeploymentState(
              status,
              canonicalStateByPod,
            );
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
                      effectiveState === "hibernated" ||
                      effectiveState === "waking"
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
                <span className="truncate min-w-0 flex-1 text-left">
                  {podName}
                </span>
              </UnstyledButton>
            );
          })()}
        </TableCell>
      )}
      <TableCell
        className="whitespace-nowrap text-muted-foreground"
        title={format(createdAt, "PPpp")}
      >
        {format(createdAt, "PP")}
      </TableCell>
      <TableCell>
        <div className="flex justify-end">
          <TableRowActions actions={actions} itemName={owner} />
        </div>
      </TableCell>
    </TableRow>
  );
}

/** Initials for a person; a team or organization icon for a shared account. */
function OwnerAvatar({
  owner,
  scope,
}: {
  owner: string;
  scope: "personal" | "team" | "org";
}) {
  const shared = scope !== "personal";
  return (
    <Avatar className={cn("size-6", shared && "rounded-md")}>
      <AvatarFallback
        className={cn(
          "text-[10px] font-medium text-muted-foreground",
          shared && "rounded-md",
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
  );
}

/** A muted (i) whose tooltip carries the explanation a paragraph used to. */
function InfoHint({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label={label}
            className="inline-flex text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <Info className="size-3.5" />
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
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

// The catalog-level "default credential" setting as one line: "Agents connect
// as [select]", with the explanation in a tooltip. It governs every tool
// assignment that resolves credentials at call time — Auto mode always, and
// Custom-mode assignments unless a specific connection is pinned on the
// assignment itself. NULL (default) = agents act on behalf of whoever is
// calling, using that person's own connection; an mcp_servers.id = agents
// always use that one connection. Saves on change; gated by the same
// authorization as editing the catalog item.
const ON_BEHALF_OF_VALUE = "__on_behalf_of__";

function AgentConnectionsSection({
  item,
  connections,
}: {
  item: NonNullable<Parameters<typeof useCanModifyCatalogItem>[0]>;
  connections: NonNullable<ReturnType<typeof useMcpServers>["data"]>;
}) {
  const { canModify } = useCanModifyCatalogItem(item);
  const updateMutation = useUpdateInternalMcpCatalogItem();
  const serviceAccountConnections = connections.filter(
    (connection) => resolveServerScope(connection) !== "personal",
  );
  const pinnedId = item.dynamicConnectionMcpServerId ?? null;
  const pinnedConnection = pinnedId
    ? serviceAccountConnections.find((connection) => connection.id === pinnedId)
    : undefined;
  const pinUnresolved = Boolean(pinnedId) && !pinnedConnection;

  const applyDefault = (value: string | null) =>
    updateMutation.mutate({
      id: item.id,
      data: { dynamicConnectionMcpServerId: value },
    });

  const handleSelectDefault = (value: string) => {
    if (value === ON_BEHALF_OF_VALUE) {
      applyDefault(null);
      return;
    }
    applyDefault(value);
  };

  const connectionLabel = (connection: (typeof connections)[number]) => {
    const scope = resolveServerScope(connection);
    if (scope === "org") return "Organization account";
    if (scope === "team")
      return `Team — ${connection.teamDetails?.name ?? "Unknown team"}`;
    return "Service account";
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
      <span className="text-muted-foreground">Agents connect as</span>
      <Select
        value={pinUnresolved ? "" : (pinnedId ?? ON_BEHALF_OF_VALUE)}
        disabled={!canModify || updateMutation.isPending}
        onValueChange={handleSelectDefault}
      >
        <SelectTrigger size="sm" className="min-w-[200px]">
          <SelectValue placeholder="Unavailable account" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            value={ON_BEHALF_OF_VALUE}
            className="cursor-pointer"
            description="Recommended"
          >
            The caller
          </SelectItem>
          {serviceAccountConnections.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
                Always use
              </div>
              {serviceAccountConnections.map((connection) => (
                <SelectItem
                  key={connection.id}
                  value={connection.id}
                  className="cursor-pointer"
                >
                  <KeyRound className="size-3.5 text-muted-foreground" />
                  {connectionLabel(connection)}
                </SelectItem>
              ))}
            </>
          )}
        </SelectContent>
      </Select>
      {pinUnresolved ? (
        <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
          <TriangleAlert className="size-3.5" />
          Selected account is unavailable — using the caller
        </span>
      ) : null}
      <InfoHint label="How agents pick a credential">
        {pinnedConnection
          ? "Every call uses this account, no matter who is calling."
          : "Each caller uses their own connection, or a team or organization one they can access."}{" "}
        Applies in Auto mode and to Custom tools resolved at call time.
      </InfoHint>
      <ExternalDocsLink
        href={getDocsUrl(DocsPage.McpAuthentication, "resolve-at-call-time")}
        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        showIcon={false}
      >
        Learn more
      </ExternalDocsLink>
    </div>
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
