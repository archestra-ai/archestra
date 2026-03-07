"use client";

import { E2eTestId, formatSecretStorageType } from "@shared";
import { format } from "date-fns";
import {
  AlertTriangle,
  ChevronDown,
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

interface ManageUsersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  label?: string;
  catalogId: string;
  /** Called when user wants to add a personal connection */
  onAddPersonalConnection?: () => void;
  /** Called when user wants to add a shared connection for a specific team */
  onAddSharedConnection?: (teamId: string) => void;
}

export function ManageUsersDialog({
  isOpen,
  onClose,
  label,
  catalogId,
  onAddPersonalConnection,
  onAddSharedConnection,
}: ManageUsersDialogProps) {
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
    if (isOpen && serversFetched && !firstServer && !hasAddCallbacks) {
      onClose();
    }
  }, [isOpen, serversFetched, firstServer, onClose, hasAddCallbacks]);

  if (!firstServer && !hasAddCallbacks) {
    return null;
  }

  // Compute which teams don't already have a connection
  const teamsWithConnection = new Set(
    allServers?.filter((s) => s.teamId).map((s) => s.teamId),
  );
  const hasPersonalConnection = allServers?.some(
    (s) => s.ownerId === currentUserId && !s.teamId,
  );
  const availableTeamsForShared =
    userTeams?.filter((t) => !teamsWithConnection.has(t.id)) ?? [];

  const getCredentialOwnerName = (
    mcpServer: (typeof allServers)[number],
  ): string =>
    mcpServer.teamId
      ? mcpServer.teamDetails?.name || "Team"
      : mcpServer.ownerEmail || "Deleted user";

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="sm:max-w-[800px]"
        data-testid={E2eTestId.ManageCredentialsDialog}
      >
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

        <div className="py-4 space-y-6">
          {allServers?.length === 0 &&
          !onAddPersonalConnection &&
          !onAddSharedConnection ? (
            <div className="text-center py-8 text-muted-foreground">
              No connections available for this server.
            </div>
          ) : (
            <>
              <ConnectionsTable
                title="Personal connections"
                servers={allServers?.filter((s) => !s.teamId) ?? []}
                isOAuthServer={isOAuthServer}
                getCredentialOwnerName={getCredentialOwnerName}
                canReauthenticate={canReauthenticate}
                getReauthTooltip={getReauthTooltip}
                canRevoke={canRevoke}
                getRevokeTooltip={getRevokeTooltip}
                handleReauthenticate={handleReauthenticate}
                handleRevoke={handleRevoke}
                isDeleting={deleteMcpServerMutation.isPending}
                onAdd={
                  onAddPersonalConnection
                    ? () => {
                        onClose();
                        onAddPersonalConnection();
                      }
                    : undefined
                }
                addDisabled={!!hasPersonalConnection}
                addDisabledReason="You already have a personal connection"
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
              />
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ServerEntry = NonNullable<
  ReturnType<typeof useMcpServers>["data"]
>[number];

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
  onAdd,
  addDisabled,
  addDisabledReason,
  teamOptions,
  onAddForTeam,
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
}) {
  const hasAddButton = onAdd || (teamOptions && onAddForTeam);
  if (servers.length === 0 && !hasAddButton) return null;

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
                        Add
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
