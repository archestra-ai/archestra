"use client";

import {
  E2eTestId,
  formatSecretStorageType,
  getManageCredentialsAddToTeamOptionTestId,
  type McpDeploymentStatusEntry,
} from "@shared";
import { format } from "date-fns";
import {
  AlertTriangle,
  ChevronDown,
  PlugZap,
  Plus,
  RefreshCw,
  Trash,
  User,
} from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useInitiateOAuth } from "@/lib/auth/oauth.query";
import {
  setOAuthCatalogId,
  setOAuthMcpServerId,
  setOAuthState,
} from "@/lib/auth/oauth-session";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useDeleteMcpServer, useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useTeams } from "@/lib/teams/team.query";
import { type DeploymentState, DeploymentStatusDot } from "./deployment-status";

interface ManageUsersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  label?: string;
  catalogId: string;
  /** Called when user wants to add a personal connection */
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
}: ManageUsersContentProps) {
  // Subscribe to live mcp-servers query to get fresh data
  const { data: allServers = [], isFetched: serversFetched } = useMcpServers({
    catalogId,
  });
  const { data: catalogItems } = useInternalMcpCatalog({});
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  // Get user's teams and permissions for re-authentication checks
  const { data: userTeams } = useTeams();
  const { data: hasTeamAdminPermission } = useHasPermissions({
    team: ["admin"],
  });
  const { data: hasMcpServerCreatePermission } = useHasPermissions({
    mcpServerInstallation: ["create"],
  });
  const { data: hasMcpServerUpdatePermission } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  const { data: hasMcpServerAdminPermission } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });

  // Use the first server for display purposes
  const firstServer = allServers?.[0];

  // Find the catalog item to check if it supports OAuth
  const catalogItem = catalogItems?.find((item) => item.id === catalogId);
  const isOAuthServer = !!catalogItem?.oauthConfig;

  const getServerScope = (
    mcpServer: (typeof allServers)[number],
  ): "personal" | "team" | "org" => {
    return mcpServer.scope ?? (mcpServer.teamId ? "team" : "personal");
  };

  // Check if user can re-authenticate a credential
  // WHY: Permission requirements match team installation rules for consistency:
  // - Personal: mcpServer:create AND owner
  // - Team: team:admin OR (mcpServer:update AND team membership)
  // - Org: mcpServerInstallation:admin
  // Members cannot re-authenticate team credentials, only editors and admins can.
  const canReauthenticate = (mcpServer: (typeof allServers)[number]) => {
    // Must have mcpServer create permission
    if (!hasMcpServerCreatePermission) return false;
    const scope = getServerScope(mcpServer);

    if (scope === "org") {
      return !!hasMcpServerAdminPermission;
    }

    // For personal credentials, only owner can re-authenticate
    if (scope === "personal") {
      return mcpServer.ownerId === currentUserId;
    }

    // For team credentials: team:admin OR (mcpServer:update AND team membership)
    if (hasTeamAdminPermission) return true;

    // WHY: Editors have mcpServer:update, members don't
    // This ensures only editors and admins can manage team credentials
    if (!hasMcpServerUpdatePermission) return false;

    return userTeams?.some((team) => team.id === mcpServer.teamId) ?? false;
  };

  // Get tooltip message for disabled re-authenticate button
  const getReauthTooltip = (mcpServer: (typeof allServers)[number]): string => {
    if (!hasMcpServerCreatePermission) {
      return "You need MCP server create permission to re-authenticate";
    }
    const scope = getServerScope(mcpServer);
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

  // Check if user can revoke (delete) a credential
  // Personal: owner OR mcpServer:update. Team: team:admin OR (mcpServer:update AND membership).
  // Org: mcpServerInstallation:admin.
  const canRevoke = (mcpServer: (typeof allServers)[number]) => {
    const scope = getServerScope(mcpServer);
    if (scope === "org") return !!hasMcpServerAdminPermission;
    if (scope === "personal") {
      return (
        mcpServer.ownerId === currentUserId || !!hasMcpServerUpdatePermission
      );
    }
    if (hasTeamAdminPermission) return true;
    if (!hasMcpServerUpdatePermission) return false;
    return userTeams?.some((team) => team.id === mcpServer.teamId) ?? false;
  };

  // Get tooltip message for disabled revoke button
  const getRevokeTooltip = (mcpServer: (typeof allServers)[number]): string => {
    const scope = getServerScope(mcpServer);
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
  const initiateOAuthMutation = useInitiateOAuth();

  const handleRevoke = async (mcpServer: (typeof allServers)[number]) => {
    await deleteMcpServerMutation.mutateAsync({
      id: mcpServer.id,
      name: mcpServer.name,
    });
  };

  const handleReauthenticate = async (
    mcpServer: (typeof allServers)[number],
  ) => {
    if (!catalogItem) {
      toast.error("Catalog item not found");
      return;
    }

    try {
      // Store the MCP server ID in session storage for re-authentication flow
      setOAuthMcpServerId(mcpServer.id);

      // Call backend to initiate OAuth flow
      const { authorizationUrl, state } =
        await initiateOAuthMutation.mutateAsync({
          catalogId: catalogItem.id,
        });

      // Store state in session storage for the callback
      setOAuthState(state);
      setOAuthCatalogId(catalogItem.id);

      // Redirect to OAuth provider
      window.location.href = authorizationUrl;
    } catch {
      setOAuthMcpServerId(null);
      toast.error("Failed to initiate re-authentication");
    }
  };

  // Close dialog when all credentials are revoked (only after data has loaded)
  // But keep dialog open if add callbacks are available
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

  const teamServers =
    allServers?.filter((s) => getServerScope(s) === "team" && !!s.teamId) ?? [];
  const orgServers =
    allServers?.filter((s) => getServerScope(s) === "org") ?? [];
  const teamsWithConnection = new Set(teamServers.map((s) => s.teamId));
  const myPersonalServer =
    allServers?.find(
      (s) => getServerScope(s) === "personal" && s.ownerId === currentUserId,
    ) ?? null;
  const otherPersonalServers =
    allServers?.filter(
      (s) => getServerScope(s) === "personal" && s.ownerId !== currentUserId,
    ) ?? [];
  const availableTeamsForShared =
    userTeams?.filter((t) => !teamsWithConnection.has(t.id)) ?? [];
  const hasOrgConnection = orgServers.length > 0;

  const getCredentialOwnerName = (
    mcpServer: (typeof allServers)[number],
  ): string => {
    const scope = getServerScope(mcpServer);
    if (scope === "org") return "Organization";
    if (scope === "team") return mcpServer.teamDetails?.name || "Team";
    return mcpServer.ownerEmail || "Deleted user";
  };

  return (
    <>
      {!hideHeader && (
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Manage credentials
            <span className="text-muted-foreground font-normal">
              {label || firstServer?.name}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Manage credentials
          </DialogDescription>
        </DialogHeader>
      )}

      <div className={hideHeader ? "space-y-6 px-4 py-4" : "space-y-6 pb-4"}>
        {allServers?.length === 0 &&
        !onAddPersonalConnection &&
        !onAddSharedConnection &&
        !onAddOrgConnection ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlugZap />
              </EmptyMedia>
              <EmptyDescription>
                No credentials available for this server.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <UnifiedConnectionsTable
            myPersonalServer={myPersonalServer}
            otherPersonalServers={otherPersonalServers}
            teamServers={teamServers}
            orgServers={orgServers}
            isOAuthServer={isOAuthServer}
            getCredentialOwnerName={getCredentialOwnerName}
            canReauthenticate={canReauthenticate}
            getReauthTooltip={getReauthTooltip}
            canRevoke={canRevoke}
            getRevokeTooltip={getRevokeTooltip}
            handleReauthenticate={handleReauthenticate}
            handleRevoke={handleRevoke}
            isDeleting={deleteMcpServerMutation.isPending}
            deploymentStatuses={deploymentStatuses}
            onOpenPodLogs={onOpenPodLogs}
            onAddPersonal={
              onAddPersonalConnection && !myPersonalServer
                ? () => {
                    onClose();
                    onAddPersonalConnection();
                  }
                : undefined
            }
            availableTeamsForShared={availableTeamsForShared}
            onAddForTeam={
              onAddSharedConnection
                ? (teamId) => {
                    onClose();
                    onAddSharedConnection(teamId);
                  }
                : undefined
            }
            onAddForOrg={
              onAddOrgConnection && !hasOrgConnection
                ? () => {
                    onClose();
                    onAddOrgConnection();
                  }
                : undefined
            }
            addOrgDisabled={!hasMcpServerAdminPermission}
            addOrgDisabledReason={
              !hasMcpServerAdminPermission
                ? "Only organization admins can install organization-wide"
                : undefined
            }
          />
        )}
      </div>

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

function UnifiedConnectionsTable({
  myPersonalServer,
  otherPersonalServers,
  teamServers,
  orgServers,
  isOAuthServer,
  getCredentialOwnerName,
  canReauthenticate,
  getReauthTooltip,
  canRevoke,
  getRevokeTooltip,
  handleReauthenticate,
  handleRevoke,
  isDeleting,
  deploymentStatuses = {},
  onOpenPodLogs,
  onAddPersonal,
  availableTeamsForShared,
  onAddForTeam,
  onAddForOrg,
  addOrgDisabled,
  addOrgDisabledReason,
}: {
  myPersonalServer: ServerEntry | null;
  otherPersonalServers: ServerEntry[];
  teamServers: ServerEntry[];
  orgServers: ServerEntry[];
  isOAuthServer: boolean;
  getCredentialOwnerName: (s: ServerEntry) => string;
  canReauthenticate: (s: ServerEntry) => boolean;
  getReauthTooltip: (s: ServerEntry) => string;
  canRevoke: (s: ServerEntry) => boolean;
  getRevokeTooltip: (s: ServerEntry) => string;
  handleReauthenticate: (s: ServerEntry) => void;
  handleRevoke: (s: ServerEntry) => void;
  isDeleting: boolean;
  deploymentStatuses?: Record<string, McpDeploymentStatusEntry>;
  onOpenPodLogs?: (serverId: string) => void;
  onAddPersonal?: () => void;
  availableTeamsForShared: Array<{ id: string; name: string }>;
  onAddForTeam?: (teamId: string) => void;
  onAddForOrg?: () => void;
  addOrgDisabled?: boolean;
  addOrgDisabledReason?: string;
}) {
  const rows = [
    ...(myPersonalServer
      ? [{ server: myPersonalServer, isYou: true } as const]
      : []),
    ...otherPersonalServers.map((s) => ({ server: s, isYou: false }) as const),
    ...teamServers.map((s) => ({ server: s, isYou: false }) as const),
    ...orgServers.map((s) => ({ server: s, isYou: false }) as const),
  ];

  const hasDeploymentStatuses = rows.some(
    (r) => deploymentStatuses[r.server.id],
  );

  const teamItems =
    onAddForTeam && availableTeamsForShared.length > 0
      ? availableTeamsForShared.map((team) => ({
          key: `team-${team.id}`,
          label: `Install for ${team.name}`,
          onClick: () => onAddForTeam(team.id),
          testId: getManageCredentialsAddToTeamOptionTestId(team.name),
        }))
      : [];

  const installItems = [
    ...(onAddPersonal
      ? [
          {
            key: "personal",
            label: "Install for myself",
            onClick: onAddPersonal,
            testId: undefined as string | undefined,
          },
        ]
      : []),
    ...(onAddForOrg
      ? [
          {
            key: "org",
            label: "Install for organization",
            onClick: onAddForOrg,
            disabled: !!addOrgDisabled,
            disabledReason: addOrgDisabledReason,
            testId: E2eTestId.ManageCredentialsAddToOrgButton,
          },
        ]
      : []),
    ...teamItems,
  ];

  const installMenu =
    installItems.length === 0 ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            data-testid={E2eTestId.ManageCredentialsAddToTeamButton}
          >
            <Plus className="mr-1 h-3 w-3" />
            Install
            <ChevronDown className="ml-1 h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {installItems.map((item) => {
            const disabled = "disabled" in item && item.disabled;
            const reason =
              "disabledReason" in item ? item.disabledReason : undefined;
            const node = (
              <DropdownMenuItem
                key={item.key}
                onClick={disabled ? undefined : item.onClick}
                disabled={disabled}
                data-testid={item.testId}
              >
                {item.label}
              </DropdownMenuItem>
            );
            if (disabled && reason) {
              return (
                <TooltipProvider key={item.key}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div>{node}</div>
                    </TooltipTrigger>
                    <TooltipContent>{reason}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            }
            return <div key={item.key}>{node}</div>;
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );

  if (rows.length === 0) {
    return (
      <Empty className="border rounded-md py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PlugZap />
          </EmptyMedia>
          <EmptyDescription>No credentials yet.</EmptyDescription>
        </EmptyHeader>
        {installMenu && (
          <EmptyContent className="flex-row justify-center">
            {installMenu}
          </EmptyContent>
        )}
      </Empty>
    );
  }

  return (
    <div className="space-y-2">
      {installMenu && (
        <div className="flex items-center justify-end">{installMenu}</div>
      )}
      <div className="rounded-md border">
        <Table data-testid={E2eTestId.ManageCredentialsDialogTable}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[220px]">Owner</TableHead>
              {hasDeploymentStatuses && <TableHead>Pod</TableHead>}
              <TableHead>Secret Storage</TableHead>
              <TableHead>Created At</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ server, isYou }) => (
              <TableRow
                key={server.id}
                data-testid={E2eTestId.CredentialRow}
                data-server-id={server.id}
              >
                <TableCell className="font-medium max-w-[220px]">
                  <div className="flex items-center gap-2">
                    {isOAuthServer && server.oauthRefreshError && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Authentication failed. Please re-authenticate.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    <span
                      className="truncate"
                      data-testid={E2eTestId.CredentialOwner}
                    >
                      {getCredentialOwnerName(server)}
                    </span>
                    {isYou && (
                      <Badge variant="secondary" className="text-[10px]">
                        You
                      </Badge>
                    )}
                  </div>
                  {(server.teamId || server.scope === "org") && (
                    <span className="text-muted-foreground text-xs block">
                      Created by: {server.ownerEmail}
                    </span>
                  )}
                </TableCell>
                {hasDeploymentStatuses && (
                  <TableCell>
                    {deploymentStatuses[server.id] ? (
                      <button
                        type="button"
                        onClick={() => onOpenPodLogs?.(server.id)}
                        className="flex items-center gap-1.5 text-sm hover:underline cursor-pointer"
                      >
                        <DeploymentStatusDot
                          state={
                            (deploymentStatuses[server.id].state ===
                              "not_created" ||
                            deploymentStatuses[server.id].state === "succeeded"
                              ? "running"
                              : deploymentStatuses[server.id]
                                  .state) as DeploymentState
                          }
                        />
                        <span className="truncate max-w-[150px]">
                          {server.name}
                        </span>
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">
                  {formatSecretStorageType(server.secretStorageType)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {format(new Date(server.createdAt), "PPp")}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    {isOAuthServer && server.oauthRefreshError && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="w-full">
                              <Button
                                onClick={() => handleReauthenticate(server)}
                                disabled={!canReauthenticate(server)}
                                size="sm"
                                variant="outline"
                                className="h-7 w-full text-xs"
                              >
                                <RefreshCw className="mr-1 h-3 w-3" />
                                Re-authenticate
                              </Button>
                            </span>
                          </TooltipTrigger>
                          {!canReauthenticate(server) && (
                            <TooltipContent>
                              {getReauthTooltip(server)}
                            </TooltipContent>
                          )}
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="w-full">
                            <Button
                              onClick={() => handleRevoke(server)}
                              disabled={isDeleting || !canRevoke(server)}
                              size="sm"
                              variant="outline"
                              className="h-7 w-full text-xs"
                              data-testid={
                                isYou
                                  ? `${E2eTestId.RevokeCredentialButton}-personal`
                                  : `${E2eTestId.RevokeCredentialButton}-${getCredentialOwnerName(server)}`
                              }
                            >
                              <Trash className="mr-1 h-3 w-3" />
                              Revoke
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {!canRevoke(server) && (
                          <TooltipContent>
                            {getRevokeTooltip(server)}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
