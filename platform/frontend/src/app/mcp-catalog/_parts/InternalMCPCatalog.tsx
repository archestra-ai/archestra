"use client";

import type { archestraApiTypes } from "@shared";
import {
  Building2,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User,
  Wrench,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { AssignAgentDialog } from "@/app/tools/_parts/assign-agent-dialog";
import { OAuthConfirmationDialog } from "@/components/oauth-confirmation-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useRole } from "@/lib/auth.hook";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import {
  useDeleteMcpServer,
  useInstallMcpServer,
  useMcpServers,
  useMcpServerTools,
  useRevokeUserMcpServerAccess,
} from "@/lib/mcp-server.query";
import { BulkAssignAgentDialog } from "./bulk-assign-agent-dialog";
import { CreateCatalogDialog } from "./create-catalog-dialog";
import { CustomServerRequestDialog } from "./custom-server-request-dialog";
import { DeleteCatalogDialog } from "./delete-catalog-dialog";
import { EditCatalogDialog } from "./edit-catalog-dialog";
import { ManageTeamsDialog } from "./manage-teams-dialog";
import { ManageUsersDialog } from "./manage-users-dialog";
import { McpToolsDialog } from "./mcp-tools-dialog";
import { NoAuthInstallDialog } from "./no-auth-install-dialog";
import { ReinstallConfirmationDialog } from "./reinstall-confirmation-dialog";
import { RemoteServerInstallDialog } from "./remote-server-install-dialog";
import { TransportBadges } from "./transport-badges";
import { UninstallServerDialog } from "./uninstall-server-dialog";

type CatalogItemWithOptionalLabel =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] & {
    label?: string | null;
  };

function InternalServerCard({
  item,
  installed,
  isInstalling,
  needsReinstall,
  onInstall,
  onInstallTeam,
  onInstallNoAuth,
  onUninstall,
  onRevokeMyAccess,
  onReinstall,
  onEdit,
  onDelete,
  onViewTools,
  onManageUsers,
  onManageTeams,
  userCount,
  teamsCount,
  toolsAssignedCount,
  toolsDiscoveredCount,
  isCurrentUserAuthenticated,
  isAdmin,
}: {
  item: CatalogItemWithOptionalLabel;
  installed: boolean;
  isInstalling: boolean;
  needsReinstall: boolean;
  onInstall: () => void;
  onInstallTeam: () => void;
  onInstallNoAuth: () => void;
  onUninstall: () => void;
  onRevokeMyAccess?: () => void;
  onReinstall: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewTools?: () => void;
  onManageUsers?: () => void;
  onManageTeams?: () => void;
  userCount?: number;
  teamsCount?: number;
  toolsAssignedCount?: number;
  toolsDiscoveredCount?: number;
  isCurrentUserAuthenticated?: boolean;
  isAdmin: boolean;
}) {
  // Check if authentication is required
  const requiresAuth = !!(
    (item.userConfig && Object.keys(item.userConfig).length > 0) ||
    item.oauthConfig
  );

  return (
    <Card className="flex flex-col relative pt-4 min-w-[350px]">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <CardTitle className="text-lg truncate mb-1 flex items-center">
              {item.label || item.name}
            </CardTitle>
            {item.label && item.label !== item.name && (
              <p className="text-xs text-muted-foreground font-mono truncate mb-2">
                {item.name}
              </p>
            )}
            <div className="flex items-center gap-2">
              {item.oauthConfig && (
                <Badge variant="secondary" className="text-xs">
                  OAuth
                </Badge>
              )}
              <TransportBadges isRemote={item.serverType === "remote"} />
              {!requiresAuth && (
                <Badge
                  variant="secondary"
                  className="text-xs bg-green-700 text-white"
                >
                  No auth required
                </Badge>
              )}
            </div>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap gap-1 items-center flex-shrink-0 mt-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 right-2"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={onEdit}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onDelete}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-2 justify-end">
        {installed &&
          ((userCount !== undefined && userCount > 0) ||
            (teamsCount !== undefined && teamsCount > 0) ||
            (toolsAssignedCount !== undefined &&
              toolsDiscoveredCount !== undefined)) && (
            <div className="bg-muted/50 rounded-md mb-2 overflow-hidden">
              {isAdmin && userCount !== undefined && userCount > 0 && (
                <div className="flex items-center justify-between px-3 py-2 text-sm border-b border-muted">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      Personal credentials:{" "}
                      <span className="font-medium text-foreground">
                        {userCount}
                      </span>
                      {isCurrentUserAuthenticated && (
                        <Badge
                          variant="secondary"
                          className="ml-2 text-[11px] px-1.5 py-1 h-4 bg-teal-600/20 text-teal-700 dark:bg-teal-400/20 dark:text-teal-400 border-teal-600/30 dark:border-teal-400/30"
                        >
                          You
                        </Badge>
                      )}
                    </span>
                  </div>
                  {onManageUsers && (
                    <Button
                      onClick={onManageUsers}
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                    >
                      Manage
                    </Button>
                  )}
                </div>
              )}
              {teamsCount !== undefined && teamsCount > 0 && (
                <div
                  className={`flex items-center justify-between px-3 py-2 text-sm ${
                    toolsAssignedCount !== undefined &&
                    toolsDiscoveredCount !== undefined
                      ? "border-b border-muted"
                      : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      Team credentials:{" "}
                      <span className="font-medium text-foreground">
                        {teamsCount}
                      </span>
                    </span>
                  </div>
                  {isAdmin && onManageTeams && (
                    <Button
                      onClick={onManageTeams}
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                    >
                      Manage
                    </Button>
                  )}
                </div>
              )}
              {toolsAssignedCount !== undefined &&
                toolsDiscoveredCount !== undefined && (
                  <div className="flex items-center justify-between px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Wrench className="h-4 w-4 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        Tools assigned:{" "}
                        <span className="font-medium text-foreground">
                          {toolsAssignedCount} (out of {toolsDiscoveredCount})
                        </span>
                      </span>
                    </div>
                    {onViewTools && (
                      <Button
                        onClick={onViewTools}
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                      >
                        Manage
                      </Button>
                    )}
                  </div>
                )}
            </div>
          )}
        {installed ? (
          <>
            {needsReinstall && (
              <Button
                onClick={onReinstall}
                size="sm"
                variant="default"
                className="w-full"
                disabled={isInstalling}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {isInstalling ? "Reinstalling..." : "Reinstall Required"}
              </Button>
            )}
            {requiresAuth && !isCurrentUserAuthenticated && (
              <Button
                onClick={onInstall}
                disabled={isInstalling}
                size="sm"
                variant="outline"
                className="w-full"
              >
                <User className="mr-2 h-4 w-4" />
                {isInstalling ? "Adding..." : "Personal Auth"}
              </Button>
            )}
            {requiresAuth &&
              isAdmin &&
              (teamsCount === undefined || teamsCount === 0) && (
                <Button
                  onClick={onInstallTeam}
                  disabled={isInstalling}
                  size="sm"
                  variant="outline"
                  className="w-full"
                >
                  <Building2 className="mr-2 h-4 w-4" />
                  {isInstalling ? "Adding..." : "Team Auth"}
                </Button>
              )}
            {isAdmin && (
              <Button
                onClick={onUninstall}
                size="sm"
                className="w-full bg-accent text-accent-foreground hover:bg-accent"
              >
                Uninstall
              </Button>
            )}
            {!isAdmin && isCurrentUserAuthenticated && onRevokeMyAccess && (
              <Button
                onClick={onRevokeMyAccess}
                size="sm"
                className="w-full bg-accent text-accent-foreground hover:bg-accent"
              >
                Revoke my access
              </Button>
            )}
          </>
        ) : requiresAuth ? (
          <div className="flex gap-2">
            <Button
              onClick={onInstall}
              disabled={isInstalling}
              size="sm"
              variant="outline"
              className="flex-1"
            >
              <User className="mr-2 h-4 w-4" />
              {isInstalling ? "Adding..." : "Personal Auth"}
            </Button>
            {isAdmin && (
              <Button
                onClick={onInstallTeam}
                disabled={isInstalling}
                size="sm"
                variant="outline"
                className="flex-1"
              >
                <Building2 className="mr-2 h-4 w-4" />
                {isInstalling ? "Adding..." : "Team Auth"}
              </Button>
            )}
          </div>
        ) : (
          <Button
            onClick={onInstallNoAuth}
            disabled={isInstalling}
            size="sm"
            variant="outline"
            className="w-full"
          >
            {isInstalling ? "Installing..." : "Install directly"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// Wrapper component that fetches tools and computes counts
function InternalServerCardWithTools({
  item,
  installedServer,
  installingItemId,
  installMutationPending,
  onInstall,
  onInstallTeam,
  onInstallNoAuth,
  onUninstall,
  onRevokeMyAccess,
  onReinstall,
  onEdit,
  onDelete,
  onViewTools,
  onManageUsers,
  onManageTeams,
  isAdmin,
}: {
  item: CatalogItemWithOptionalLabel;
  installedServer:
    | archestraApiTypes.GetMcpServersResponses["200"][number]
    | undefined;
  installingItemId: string | null;
  installMutationPending: boolean;
  onInstall: () => void;
  onInstallTeam: () => void;
  onInstallNoAuth: () => void;
  onUninstall: () => void;
  onRevokeMyAccess?: () => void;
  onReinstall: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewTools?: () => void;
  onManageUsers?: () => void;
  onManageTeams?: () => void;
  isAdmin: boolean;
}) {
  const { data: tools } = useMcpServerTools(installedServer?.id ?? null);
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;

  const toolsDiscoveredCount = tools?.length ?? 0;
  const toolsAssignedCount = useMemo(() => {
    if (!tools) return 0;
    return tools.filter((tool) => tool.assignedAgentCount > 0).length;
  }, [tools]);

  const isCurrentUserAuthenticated = useMemo(() => {
    if (!currentUserId || !installedServer?.users) return false;
    return installedServer.users.includes(currentUserId);
  }, [currentUserId, installedServer?.users]);

  return (
    <InternalServerCard
      item={item}
      installed={!!installedServer}
      isInstalling={installingItemId === item.id || installMutationPending}
      needsReinstall={installedServer?.reinstallRequired ?? false}
      onInstall={onInstall}
      onInstallTeam={onInstallTeam}
      onInstallNoAuth={onInstallNoAuth}
      onUninstall={onUninstall}
      onRevokeMyAccess={onRevokeMyAccess}
      onReinstall={onReinstall}
      onEdit={onEdit}
      onDelete={onDelete}
      onViewTools={onViewTools}
      onManageUsers={onManageUsers}
      onManageTeams={onManageTeams}
      userCount={installedServer?.users?.length ?? 0}
      teamsCount={installedServer?.teams?.length ?? 0}
      toolsAssignedCount={toolsAssignedCount}
      toolsDiscoveredCount={toolsDiscoveredCount}
      isCurrentUserAuthenticated={isCurrentUserAuthenticated}
      isAdmin={isAdmin}
    />
  );
}

export function InternalMCPCatalog({
  initialData,
  installedServers: initialInstalledServers,
}: {
  initialData?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
  installedServers?: archestraApiTypes.GetMcpServersResponses["200"];
}) {
  const { data: catalogItems } = useInternalMcpCatalog({ initialData });
  const { data: installedServers } = useMcpServers({
    initialData: initialInstalledServers,
  });
  const installMutation = useInstallMcpServer();
  const userRole = useRole();
  const isAdmin = userRole === "admin";
  const deleteMutation = useDeleteMcpServer();
  const revokeUserAccessMutation = useRevokeUserMcpServerAccess();
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isCustomRequestDialogOpen, setIsCustomRequestDialogOpen] =
    useState(false);
  const [editingItem, setEditingItem] = useState<
    archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null
  >(null);
  const [deletingItem, setDeletingItem] = useState<
    archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null
  >(null);
  const [uninstallingServer, setUninstallingServer] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [installingItemId, setInstallingItemId] = useState<string | null>(null);
  const [catalogSearchQuery, setCatalogSearchQuery] = useState("");
  const [isRemoteServerDialogOpen, setIsRemoteServerDialogOpen] =
    useState(false);
  const [selectedCatalogItem, setSelectedCatalogItem] = useState<
    archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null
  >(null);
  const [isOAuthDialogOpen, setIsOAuthDialogOpen] = useState(false);
  const [toolsDialogServerId, setToolsDialogServerId] = useState<string | null>(
    null,
  );
  const [toolsDialogKey, setToolsDialogKey] = useState(0);
  const [selectedToolForAssignment, setSelectedToolForAssignment] = useState<{
    id: string;
    name: string;
    description: string | null;
    parameters: Record<string, unknown>;
    createdAt: string;
    mcpServerId: string | null;
    mcpServerName: string | null;
  } | null>(null);
  const [bulkAssignTools, setBulkAssignTools] = useState<
    Array<{
      id: string;
      name: string;
      description: string | null;
      parameters: Record<string, unknown>;
      createdAt: string;
    }>
  >([]);
  const [showReinstallDialog, setShowReinstallDialog] = useState(false);
  const [catalogItemForReinstall, setCatalogItemForReinstall] = useState<
    archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null
  >(null);
  const [isTeamMode, setIsTeamMode] = useState(false);
  const [isNoAuthDialogOpen, setIsNoAuthDialogOpen] = useState(false);
  const [noAuthCatalogItem, setNoAuthCatalogItem] = useState<
    archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null
  >(null);
  const [managingUsersState, setManagingUsersState] = useState<{
    server: archestraApiTypes.GetMcpServersResponses["200"][number];
    label: string;
  } | null>(null);
  const [managingTeamsState, setManagingTeamsState] = useState<{
    server: archestraApiTypes.GetMcpServersResponses["200"][number];
    label: string;
  } | null>(null);

  const toolsDialogServer = useMemo(() => {
    return installedServers?.find(
      (server) => server.id === toolsDialogServerId,
    );
  }, [installedServers, toolsDialogServerId]);

  const { data: toolsDialogTools, isLoading: isLoadingToolsDialogTools } =
    useMcpServerTools(toolsDialogServerId);

  const handleInstall = useCallback(
    async (
      catalogItem: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
      teamMode = false,
    ) => {
      setIsTeamMode(teamMode);

      // Check if this is a remote server with user configuration or it's the GitHub MCP server from the external catalog
      if (
        catalogItem.serverType === "remote" &&
        catalogItem.userConfig &&
        Object.keys(catalogItem.userConfig).length > 0
      ) {
        setSelectedCatalogItem(catalogItem);
        setIsRemoteServerDialogOpen(true);
        return;
      }

      // Check if this server requires OAuth authentication
      if (catalogItem.oauthConfig) {
        setSelectedCatalogItem(catalogItem);
        setIsOAuthDialogOpen(true);
        return;
      }

      // For servers without configuration, install directly
      try {
        setInstallingItemId(catalogItem.id);
        await installMutation.mutateAsync({
          name: catalogItem.name,
          catalogId: catalogItem.id,
          teams: [], // TODO: will be populated from team selector in dialogs
        });
      } finally {
        setInstallingItemId(null);
      }
    },
    [installMutation],
  );

  const handleInstallTeam = useCallback(
    async (
      catalogItem: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
    ) => {
      await handleInstall(catalogItem, true);
    },
    [handleInstall],
  );

  const handleInstallNoAuth = useCallback(
    (
      catalogItem: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
    ) => {
      setNoAuthCatalogItem(catalogItem);
      setIsNoAuthDialogOpen(true);
    },
    [],
  );

  const handleNoAuthConfirm = useCallback(
    async (teams: string[] = []) => {
      if (!noAuthCatalogItem) return;

      try {
        setInstallingItemId(noAuthCatalogItem.id);
        await installMutation.mutateAsync({
          name: noAuthCatalogItem.name,
          catalogId: noAuthCatalogItem.id,
          teams,
        });
        setIsNoAuthDialogOpen(false);
        setNoAuthCatalogItem(null);
      } finally {
        setInstallingItemId(null);
      }
    },
    [noAuthCatalogItem, installMutation],
  );

  const _handleGitHubInstall = useCallback(
    async (
      catalogItem: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
      accessToken: string,
      teams: string[],
    ) => {
      try {
        setInstallingItemId(catalogItem.id);
        await installMutation.mutateAsync({
          name: catalogItem.name,
          catalogId: catalogItem.id,
          accessToken,
          teams,
        });
      } finally {
        setInstallingItemId(null);
      }
    },
    [installMutation],
  );

  const handleRemoteServerInstall = useCallback(
    async (
      catalogItem: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
      metadata?: Record<string, unknown>,
      teams: string[] = [],
    ) => {
      try {
        setInstallingItemId(catalogItem.id);

        // Extract access_token from metadata if present and pass as accessToken
        const accessToken =
          metadata?.access_token && typeof metadata.access_token === "string"
            ? metadata.access_token
            : undefined;

        await installMutation.mutateAsync({
          name: catalogItem.name,
          catalogId: catalogItem.id,
          ...(accessToken && { accessToken }),
          teams,
        });
      } finally {
        setInstallingItemId(null);
      }
    },
    [installMutation],
  );

  const handleOAuthConfirm = useCallback(
    async (teams: string[] = []) => {
      if (!selectedCatalogItem) return;

      try {
        // Call backend to initiate OAuth flow
        const response = await fetch("/api/oauth/initiate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            catalogId: selectedCatalogItem.id,
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to initiate OAuth flow");
        }

        const { authorizationUrl, state } = await response.json();

        // Store state and teams in session storage for the callback
        sessionStorage.setItem("oauth_state", state);
        sessionStorage.setItem("oauth_catalog_id", selectedCatalogItem.id);
        sessionStorage.setItem("oauth_teams", JSON.stringify(teams));

        // Redirect to OAuth provider
        window.location.href = authorizationUrl;
      } catch {
        // TODO: Show error toast
      }
    },
    [selectedCatalogItem],
  );

  const getInstallationCount = useCallback(
    (catalogId: string) => {
      return (
        installedServers?.filter((server) => server.catalogId === catalogId)
          .length || 0
      );
    },
    [installedServers],
  );

  const getInstalledServer = useCallback(
    (catalogId: string) => {
      return installedServers?.find((server) => server.catalogId === catalogId);
    },
    [installedServers],
  );

  // Aggregate all installations of the same catalog item
  const getAggregatedInstallation = useCallback(
    (catalogId: string) => {
      const servers = installedServers?.filter(
        (server) => server.catalogId === catalogId,
      );

      if (!servers || servers.length === 0) return undefined;

      // If only one server, return it as-is
      if (servers.length === 1) return servers[0];

      // Use the first server with users as the base, or just first server
      const baseServer =
        servers.find((s) => s.users && s.users.length > 0) || servers[0];

      // Aggregate multiple servers
      const aggregated = { ...baseServer };

      // Combine all unique users
      const allUsers = new Set<string>();
      const allUserDetails: Array<{
        userId: string;
        email: string;
        createdAt: string;
      }> = [];

      for (const server of servers) {
        if (server.users) {
          for (const userId of server.users) {
            allUsers.add(userId);
          }
        }
        if (server.userDetails) {
          for (const userDetail of server.userDetails) {
            // Only add if not already present
            if (!allUserDetails.some((ud) => ud.userId === userDetail.userId)) {
              allUserDetails.push(userDetail);
            }
          }
        }
      }

      // Combine all unique teams
      const allTeams = new Set<string>();
      const allTeamDetails: Array<{
        teamId: string;
        name: string;
        createdAt: string;
      }> = [];

      for (const server of servers) {
        if (server.teams) {
          for (const teamId of server.teams) {
            allTeams.add(teamId);
          }
        }
        if (server.teamDetails) {
          for (const teamDetail of server.teamDetails) {
            // Only add if not already present
            if (!allTeamDetails.some((td) => td.teamId === teamDetail.teamId)) {
              allTeamDetails.push(teamDetail);
            }
          }
        }
      }

      aggregated.users = Array.from(allUsers);
      aggregated.userDetails = allUserDetails;
      aggregated.teams = Array.from(allTeams);
      aggregated.teamDetails = allTeamDetails;

      return aggregated;
    },
    [installedServers],
  );

  const handleUninstallClick = useCallback(
    (serverId: string, serverName: string) => {
      setUninstallingServer({ id: serverId, name: serverName });
    },
    [],
  );

  const handleRevokeMyAccess = useCallback(
    async (serverId: string) => {
      if (!currentUserId) {
        toast.error("User ID not found");
        return;
      }

      try {
        await revokeUserAccessMutation.mutateAsync({
          serverId,
          userId: currentUserId,
        });
      } catch (error) {
        console.error("Error revoking access:", error);
      }
    },
    [currentUserId, revokeUserAccessMutation],
  );

  const handleReinstallRequired = useCallback(
    async (
      catalogId: string,
      updatedData?: { name?: string; serverUrl?: string },
    ) => {
      // Check if there's an installed server from this catalog item
      const installedServer = getInstalledServer(catalogId);

      // Only show reinstall dialog if the server is actually installed
      if (!installedServer) {
        return;
      }

      // Wait a bit for queries to refetch after mutation
      // This ensures we have fresh catalog data
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Find the catalog item and show reinstall dialog
      let catalogItem = catalogItems?.find((item) => item.id === catalogId);

      // If we have updated data from the edit, merge it with the catalog item
      if (catalogItem && updatedData) {
        catalogItem = {
          ...catalogItem,
          ...(updatedData.name && { name: updatedData.name }),
          ...(updatedData.serverUrl && { serverUrl: updatedData.serverUrl }),
        };
      }

      if (catalogItem) {
        setCatalogItemForReinstall(catalogItem);
        setShowReinstallDialog(true);
      }
    },
    [catalogItems, getInstalledServer],
  );

  const handleReinstall = useCallback(
    async (
      catalogItem: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
    ) => {
      // Get the installed server to get its ID (not catalog ID)
      const installedServer = installedServers?.find(
        (server) => server.catalogId === catalogItem.id,
      );
      if (!installedServer) {
        toast.error("Server not found, cannot reinstall");
        return;
      }

      // Delete the installed server using its server ID
      await deleteMutation.mutateAsync({
        id: installedServer.id,
        name: catalogItem.name,
      });

      // Then reinstall
      await handleInstall(catalogItem);
    },
    [handleInstall, deleteMutation, installedServers],
  );

  const filteredCatalogItems = useMemo(() => {
    const items = catalogSearchQuery.trim()
      ? (catalogItems || []).filter((item) =>
          item.name.toLowerCase().includes(catalogSearchQuery.toLowerCase()),
        )
      : catalogItems || [];

    // Sort: installed servers first
    return items.sort((a, b) => {
      const aInstalled = installedServers?.some(
        (server) => server.catalogId === a.id,
      );
      const bInstalled = installedServers?.some(
        (server) => server.catalogId === b.id,
      );

      if (aInstalled && !bInstalled) return -1;
      if (!aInstalled && bInstalled) return 1;
      return 0;
    });
  }, [catalogItems, catalogSearchQuery, installedServers]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Private MCP Registry</h2>
          <p className="text-sm text-muted-foreground">
            MCP Servers from this registry can be assigned to your agents.
          </p>
        </div>
        <Button
          onClick={() =>
            isAdmin
              ? setIsCreateDialogOpen(true)
              : setIsCustomRequestDialogOpen(true)
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          {isAdmin
            ? "Add MCP server using config"
            : "Request to add custom MCP Server"}
        </Button>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search servers by name..."
          value={catalogSearchQuery}
          onChange={(e) => setCatalogSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredCatalogItems?.map((item) => {
          const installedServer = getAggregatedInstallation(item.id);
          const itemWithLabel = item as CatalogItemWithOptionalLabel;

          return (
            <InternalServerCardWithTools
              key={item.id}
              item={itemWithLabel}
              installedServer={installedServer}
              installingItemId={installingItemId}
              installMutationPending={installMutation.isPending}
              onInstall={() => handleInstall(item, false)}
              onInstallTeam={() => handleInstallTeam(item)}
              onInstallNoAuth={() => handleInstallNoAuth(item)}
              onUninstall={() => {
                if (installedServer) {
                  handleUninstallClick(
                    installedServer.id,
                    installedServer.name,
                  );
                }
              }}
              onRevokeMyAccess={
                installedServer
                  ? () => handleRevokeMyAccess(installedServer.id)
                  : undefined
              }
              onReinstall={() => handleReinstall(item)}
              onEdit={() => setEditingItem(item)}
              onDelete={() => setDeletingItem(item)}
              onViewTools={
                installedServer
                  ? () => setToolsDialogServerId(installedServer.id)
                  : undefined
              }
              onManageUsers={
                installedServer
                  ? () =>
                      setManagingUsersState({
                        server: installedServer,
                        label: itemWithLabel.label || itemWithLabel.name,
                      })
                  : undefined
              }
              onManageTeams={
                installedServer
                  ? () =>
                      setManagingTeamsState({
                        server: installedServer,
                        label: itemWithLabel.label || itemWithLabel.name,
                      })
                  : undefined
              }
              isAdmin={isAdmin}
            />
          );
        })}
      </div>
      {filteredCatalogItems?.length === 0 && catalogSearchQuery && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">
            No catalog items match "{catalogSearchQuery}".
          </p>
        </div>
      )}
      {catalogItems?.length === 0 && !catalogSearchQuery && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">No catalog items found.</p>
        </div>
      )}

      <CreateCatalogDialog
        isOpen={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
      />

      <CustomServerRequestDialog
        isOpen={isCustomRequestDialogOpen}
        onClose={() => setIsCustomRequestDialogOpen(false)}
      />

      <EditCatalogDialog
        item={editingItem}
        onClose={() => setEditingItem(null)}
        onReinstallRequired={handleReinstallRequired}
      />

      <DeleteCatalogDialog
        item={deletingItem}
        onClose={() => setDeletingItem(null)}
        installationCount={
          deletingItem ? getInstallationCount(deletingItem.id) : 0
        }
      />

      <RemoteServerInstallDialog
        isOpen={isRemoteServerDialogOpen}
        onClose={() => {
          setIsRemoteServerDialogOpen(false);
          setSelectedCatalogItem(null);
          setIsTeamMode(false);
        }}
        onInstall={handleRemoteServerInstall}
        catalogItem={selectedCatalogItem}
        isInstalling={installMutation.isPending}
        isTeamMode={isTeamMode}
      />

      <OAuthConfirmationDialog
        open={isOAuthDialogOpen}
        onOpenChange={setIsOAuthDialogOpen}
        serverName={selectedCatalogItem?.label || ""}
        onConfirm={handleOAuthConfirm}
        onCancel={() => {
          setIsOAuthDialogOpen(false);
          setSelectedCatalogItem(null);
          setIsTeamMode(false);
        }}
        isTeamMode={isTeamMode}
      />

      <UninstallServerDialog
        server={uninstallingServer}
        onClose={() => setUninstallingServer(null)}
      />

      <McpToolsDialog
        key={toolsDialogKey}
        open={!!toolsDialogServerId}
        onOpenChange={(open) => {
          if (!open) setToolsDialogServerId(null);
        }}
        serverName={toolsDialogServer?.name ?? ""}
        tools={toolsDialogTools ?? []}
        isLoading={isLoadingToolsDialogTools}
        onAssignTool={(tool) => {
          setSelectedToolForAssignment({
            ...tool,
            mcpServerId: toolsDialogServerId,
            mcpServerName: toolsDialogServer?.name ?? null,
          });
        }}
        onBulkAssignTools={(tools) => {
          setBulkAssignTools(tools);
        }}
      />

      <BulkAssignAgentDialog
        tools={bulkAssignTools.length > 0 ? bulkAssignTools : null}
        open={bulkAssignTools.length > 0}
        onOpenChange={(open) => {
          if (!open) {
            setBulkAssignTools([]);
            // Reset the tools dialog to clear selections
            setToolsDialogKey((prev) => prev + 1);
          }
        }}
      />

      <AssignAgentDialog
        tool={
          selectedToolForAssignment
            ? {
                id: selectedToolForAssignment.id,
                tool: {
                  id: selectedToolForAssignment.id,
                  name: selectedToolForAssignment.name,
                  description: selectedToolForAssignment.description,
                  parameters: selectedToolForAssignment.parameters,
                  createdAt: selectedToolForAssignment.createdAt,
                  updatedAt: selectedToolForAssignment.createdAt,
                  mcpServerId: selectedToolForAssignment.mcpServerId,
                  mcpServerName: selectedToolForAssignment.mcpServerName,
                },
                agent: null,
                createdAt: selectedToolForAssignment.createdAt,
                updatedAt: selectedToolForAssignment.createdAt,
              }
            : null
        }
        open={!!selectedToolForAssignment}
        onOpenChange={(open) => {
          if (!open) setSelectedToolForAssignment(null);
        }}
      />

      <ReinstallConfirmationDialog
        isOpen={showReinstallDialog}
        onClose={() => {
          setShowReinstallDialog(false);
          setCatalogItemForReinstall(null);
        }}
        onConfirm={async () => {
          if (catalogItemForReinstall) {
            setShowReinstallDialog(false);
            await handleReinstall(catalogItemForReinstall);
            setCatalogItemForReinstall(null);
          }
        }}
        serverName={
          catalogItemForReinstall?.label || catalogItemForReinstall?.name || ""
        }
        isReinstalling={installMutation.isPending}
      />

      <NoAuthInstallDialog
        isOpen={isNoAuthDialogOpen}
        onClose={() => {
          setIsNoAuthDialogOpen(false);
          setNoAuthCatalogItem(null);
        }}
        onInstall={handleNoAuthConfirm}
        catalogItem={noAuthCatalogItem}
        isInstalling={installMutation.isPending}
        isAdmin={isAdmin}
      />

      <ManageUsersDialog
        isOpen={!!managingUsersState}
        onClose={() => setManagingUsersState(null)}
        server={managingUsersState?.server}
        label={managingUsersState?.label}
      />

      <ManageTeamsDialog
        isOpen={!!managingTeamsState}
        onClose={() => setManagingTeamsState(null)}
        server={managingTeamsState?.server}
        label={managingTeamsState?.label}
      />
    </div>
  );
}
