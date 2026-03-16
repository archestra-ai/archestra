"use client";

import {
  E2eTestId,
  formatSecretStorageType,
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
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import { useDeleteMcpServer, useMcpServers } from "@/lib/mcp-server.query";
import { useInitiateOAuth } from "@/lib/oauth.query";
import {
  setOAuthCatalogId,
  setOAuthMcpServerId,
  setOAuthState,
} from "@/lib/oauth-session";
import { useTeams } from "@/lib/team.query";
import { type DeploymentState, DeploymentStatusDot } from "./deployment-status";

interface ManageUsersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  label?: string;
  catalogId: string;
  /** Called when user wants to add a personal connection */
  onAddPersonalConnection?: () => void;
  /** Called when user wants to add a shared connection for a specific team */
  onAddSharedConnection?: (teamId: string) => void;
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
  deploymentStatuses?: Record<string, McpDeploymentStatusEntry>;
  onOpenPodLogs?: (serverId: string) => void;
  hideHeader?: boolean;
  variant?: "remote" | "local" | "builtin";
}

export function ManageUsersContent({
  isActive,
  onClose,
  label,
  catalogId,
  onAddPersonalConnection,
  onAddSharedConnection,
  deploymentStatuses = {},
  onOpenPodLogs,
  hideHeader = false,
  variant,
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

  // Use the first server for display purposes
  const firstServer = allServers?.[0];

  // Find the catalog item to check if it supports OAuth
  const catalogItem = catalogItems?.find((item) => item.id === catalogId);
  const isOAuthServer = !!catalogItem?.oauthConfig;

  // Check if user can re-authenticate a credential
  // WHY: Permission requirements match team installation rules for consistency:
  // - Personal: mcpServer:create AND owner
  // - Team: team:admin OR (mcpServer:update AND team membership)
  // Members cannot re-authenticate team credentials, only editors and admins can.
  const canReauthenticate = (mcpServer: (typeof allServers)[number]) => {
    // Must have mcpServer create permission
    if (!hasMcpServerCreatePermission) return false;

    // For personal credentials, only owner can re-authenticate
    if (!mcpServer.teamId) {
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
    if (!mcpServer.teamId) {
      return "Only the connection owner can re-authenticate";
    }
    // WHY: Different messages for different failure reasons
    if (!hasMcpServerUpdatePermission) {
      return "You don't have permission to re-authenticate team connections";
    }
    return "You can only re-authenticate connections for teams you are a member of";
  };

  // Check if user can revoke (delete) a credential
  // Personal: owner OR mcpServer:update. Team: team:admin OR (mcpServer:update AND membership)
  const canRevoke = (mcpServer: (typeof allServers)[number]) => {
    if (!mcpServer.teamId) {
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
    if (!mcpServer.teamId) {
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
  const hasAddCallbacks = !!onAddPersonalConnection || !!onAddSharedConnection;
  useEffect(() => {
    if (isActive && serversFetched && !firstServer && !hasAddCallbacks) {
      onClose();
    }
  }, [isActive, serversFetched, firstServer, onClose, hasAddCallbacks]);

  if (!firstServer && !hasAddCallbacks) {
    return null;
  }

  // Compute which teams don't already have a connection
  const teamsWithConnection = new Set(
    allServers?.filter((s) => s.teamId).map((s) => s.teamId),
  );
  const myPersonalServer =
    allServers?.find((s) => s.ownerId === currentUserId && !s.teamId) ?? null;
  const otherPersonalServers =
    allServers?.filter((s) => !s.teamId && s.ownerId !== currentUserId) ?? [];
  const availableTeamsForShared =
    userTeams?.filter((t) => !teamsWithConnection.has(t.id)) ?? [];

  const getCredentialOwnerName = (
    mcpServer: (typeof allServers)[number],
  ): string =>
    mcpServer.teamId
      ? mcpServer.teamDetails?.name || "Team"
      : mcpServer.ownerEmail || "Deleted user";

  return (
    <>
      {!hideHeader && (
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Manage connections
            <span className="text-muted-foreground font-normal">
              {label || firstServer?.name}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Manage connections
          </DialogDescription>
        </DialogHeader>
      )}

      <div className={hideHeader ? "space-y-6 px-4 py-4" : "space-y-6 pb-4"}>
        {allServers?.length === 0 &&
        !onAddPersonalConnection &&
        !onAddSharedConnection ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlugZap />
              </EmptyMedia>
              <EmptyDescription>
                No connections available for this server.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <YourPersonalConnection
              server={myPersonalServer}
              isOAuthServer={isOAuthServer}
              canReauthenticate={canReauthenticate}
              getReauthTooltip={getReauthTooltip}
              canRevoke={canRevoke}
              getRevokeTooltip={getRevokeTooltip}
              handleReauthenticate={handleReauthenticate}
              handleRevoke={handleRevoke}
              isDeleting={deleteMcpServerMutation.isPending}
              deploymentStatuses={deploymentStatuses}
              onOpenPodLogs={onOpenPodLogs}
              onInstall={
                onAddPersonalConnection
                  ? () => {
                      onClose();
                      onAddPersonalConnection();
                    }
                  : undefined
              }
              variant={variant}
            />
            <ConnectionsTable
              title="Other personal connections"
              servers={otherPersonalServers}
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
              alwaysShow
            />
            <ConnectionsTable
              title="Shared connections"
              servers={allServers?.filter((s) => !!s.teamId) ?? []}
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
              teamOptions={
                onAddSharedConnection ? availableTeamsForShared : undefined
              }
              onAddForTeam={
                onAddSharedConnection
                  ? (teamId) => {
                      onClose();
                      onAddSharedConnection(teamId);
                    }
                  : undefined
              }
              alwaysShow
            />
          </>
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

function YourPersonalConnection({
  server,
  isOAuthServer,
  canReauthenticate,
  getReauthTooltip,
  canRevoke,
  getRevokeTooltip,
  handleReauthenticate,
  handleRevoke,
  isDeleting,
  deploymentStatuses = {},
  onOpenPodLogs,
  onInstall,
  variant,
}: {
  server: ServerEntry | null;
  isOAuthServer: boolean;
  canReauthenticate: (s: ServerEntry) => boolean;
  getReauthTooltip: (s: ServerEntry) => string;
  canRevoke: (s: ServerEntry) => boolean;
  getRevokeTooltip: (s: ServerEntry) => string;
  handleReauthenticate: (s: ServerEntry) => void;
  handleRevoke: (s: ServerEntry) => void;
  isDeleting: boolean;
  deploymentStatuses?: Record<string, McpDeploymentStatusEntry>;
  onOpenPodLogs?: (serverId: string) => void;
  onInstall?: () => void;
  variant?: "remote" | "local" | "builtin";
}) {
  const isLocal = variant === "local";
  const deploymentStatus = server ? deploymentStatuses[server.id] : undefined;

  return (
    <div>
      <h4 className="text-sm font-medium mb-2">Your personal connection</h4>
      {!server ? (
        <Empty className="border rounded-md py-6 md:py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugZap />
            </EmptyMedia>
            <EmptyDescription>
              You don&apos;t have a personal connection yet.
            </EmptyDescription>
          </EmptyHeader>
          {onInstall && (
            <EmptyContent className="flex-row justify-center">
              <Button onClick={onInstall}>
                {variant === "remote" ? "Connect" : "Install"}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {isLocal && <TableHead>Pod</TableHead>}
                <TableHead>Secret Storage</TableHead>
                <TableHead>Created At</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow data-testid={E2eTestId.CredentialRow}>
                {isLocal && (
                  <TableCell>
                    {deploymentStatus ? (
                      <button
                        type="button"
                        onClick={() => onOpenPodLogs?.(server.id)}
                        className="flex items-center gap-1.5 text-sm hover:underline cursor-pointer"
                      >
                        <DeploymentStatusDot
                          state={
                            (deploymentStatus.state === "not_created" ||
                            deploymentStatus.state === "succeeded"
                              ? "running"
                              : deploymentStatus.state) as DeploymentState
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
                              data-testid={`${E2eTestId.RevokeCredentialButton}-personal`}
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
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function ConnectionsTable({
  title,
  servers,
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
  onAdd,
  addDisabled,
  addDisabledReason,
  teamOptions,
  onAddForTeam,
  alwaysShow = false,
}: {
  title: string;
  servers: ServerEntry[];
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
  /** Simple add button (for personal connections) */
  onAdd?: () => void;
  /** Disable the simple add button */
  addDisabled?: boolean;
  /** Tooltip reason when add button is disabled */
  addDisabledReason?: string;
  /** Team options for dropdown add button (for shared connections) */
  teamOptions?: Array<{ id: string; name: string }>;
  /** Called when a team is selected from the dropdown */
  onAddForTeam?: (teamId: string) => void;
  /** Always show the section even when empty and no add button */
  alwaysShow?: boolean;
}) {
  const hasAddButton = onAdd || (teamOptions && onAddForTeam);
  if (servers.length === 0 && !hasAddButton && !alwaysShow) return null;
  const hasDeploymentStatuses = servers.some((s) => deploymentStatuses[s.id]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium">{title}</h4>
        {onAdd && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={onAdd}
                    disabled={addDisabled}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Add
                  </Button>
                </span>
              </TooltipTrigger>
              {addDisabled && addDisabledReason && (
                <TooltipContent>{addDisabledReason}</TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        )}
        {teamOptions && onAddForTeam && (
          <DropdownMenu>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={teamOptions.length === 0}
                      >
                        <Plus className="mr-1 h-3 w-3" />
                        Add to team
                        <ChevronDown className="ml-1 h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                  </span>
                </TooltipTrigger>
                {teamOptions.length === 0 && (
                  <TooltipContent>
                    All teams already have a connection
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            <DropdownMenuContent align="end">
              {teamOptions.map((team) => (
                <DropdownMenuItem
                  key={team.id}
                  onClick={() => onAddForTeam(team.id)}
                >
                  {team.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {servers.length === 0 ? (
        <div className="text-center py-4 text-sm text-muted-foreground border rounded-md">
          No {title.toLowerCase()} yet.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table data-testid={E2eTestId.ManageCredentialsDialogTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[200px]">Owner</TableHead>
                {hasDeploymentStatuses && <TableHead>Pod</TableHead>}
                <TableHead>Secret Storage</TableHead>
                <TableHead>Created At</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((mcpServer) => (
                <TableRow
                  key={mcpServer.id}
                  data-testid={E2eTestId.CredentialRow}
                  data-server-id={mcpServer.id}
                >
                  <TableCell className="font-medium max-w-[200px]">
                    <div className="flex items-center gap-2">
                      {isOAuthServer && mcpServer.oauthRefreshError && (
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
                        {getCredentialOwnerName(mcpServer)}
                      </span>
                    </div>
                    {mcpServer.teamId && (
                      <span className="text-muted-foreground text-xs block">
                        Created by: {mcpServer.ownerEmail}
                      </span>
                    )}
                  </TableCell>
                  {hasDeploymentStatuses && (
                    <TableCell>
                      {deploymentStatuses[mcpServer.id] ? (
                        <button
                          type="button"
                          onClick={() => {
                            onOpenPodLogs?.(mcpServer.id);
                          }}
                          className="flex items-center gap-1.5 text-sm hover:underline cursor-pointer"
                        >
                          <DeploymentStatusDot
                            state={
                              (deploymentStatuses[mcpServer.id].state ===
                                "not_created" ||
                              deploymentStatuses[mcpServer.id].state ===
                                "succeeded"
                                ? "running"
                                : deploymentStatuses[mcpServer.id]
                                    .state) as DeploymentState
                            }
                          />
                          <span className="truncate max-w-[150px]">
                            {mcpServer.name}
                          </span>
                        </button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-muted-foreground">
                    {formatSecretStorageType(mcpServer.secretStorageType)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format(new Date(mcpServer.createdAt), "PPp")}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      {isOAuthServer && mcpServer.oauthRefreshError && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="w-full">
                                <Button
                                  onClick={() =>
                                    handleReauthenticate(mcpServer)
                                  }
                                  disabled={!canReauthenticate(mcpServer)}
                                  size="sm"
                                  variant="outline"
                                  className="h-7 w-full text-xs"
                                >
                                  <RefreshCw className="mr-1 h-3 w-3" />
                                  Re-authenticate
                                </Button>
                              </span>
                            </TooltipTrigger>
                            {!canReauthenticate(mcpServer) && (
                              <TooltipContent>
                                {getReauthTooltip(mcpServer)}
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
                                onClick={() => handleRevoke(mcpServer)}
                                disabled={isDeleting || !canRevoke(mcpServer)}
                                size="sm"
                                variant="outline"
                                className="h-7 w-full text-xs"
                                data-testid={`${E2eTestId.RevokeCredentialButton}-${getCredentialOwnerName(mcpServer)}`}
                              >
                                <Trash className="mr-1 h-3 w-3" />
                                Revoke
                              </Button>
                            </span>
                          </TooltipTrigger>
                          {!canRevoke(mcpServer) && (
                            <TooltipContent>
                              {getRevokeTooltip(mcpServer)}
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
      )}
    </div>
  );
}
