"use client";

import { Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { OAuthConfirmationDialog } from "@/components/oauth-confirmation-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useDialogs } from "@/lib/dialog.hook";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import {
  useDeleteMcpServer,
  useInstallMcpServer,
  useMcpServerInstallationStatus,
  useMcpServers,
} from "@/lib/mcp-server.query";
import { CreateCatalogDialog } from "./create-catalog-dialog";
import { CustomServerRequestDialog } from "./custom-server-request-dialog";
import { DeleteCatalogDialog } from "./delete-catalog-dialog";
import { EditCatalogDialog } from "./edit-catalog-dialog";
import { LocalServerInstallDialog } from "./local-server-install-dialog";
import {
  type CatalogItem,
  type InstalledServer,
  McpServerCard,
} from "./mcp-server-card";
import { NoAuthInstallDialog } from "./no-auth-install-dialog";
import { ReinstallConfirmationDialog } from "./reinstall-confirmation-dialog";
import { RemoteServerInstallDialog } from "./remote-server-install-dialog";

export function InternalMCPCatalog({
  initialData,
  installedServers: initialInstalledServers,
}: {
  initialData?: CatalogItem[];
  installedServers?: InstalledServer[];
}) {
  const { data: catalogItems } = useInternalMcpCatalog({ initialData });
  const { data: installedServers } = useMcpServers({
    initialData: initialInstalledServers,
  });
  const installMutation = useInstallMcpServer();

  const deleteMutation = useDeleteMcpServer();
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;

  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    | "create"
    | "custom-request"
    | "edit"
    | "delete"
    | "remote-install"
    | "local-install"
    | "oauth"
    | "no-auth"
    | "reinstall"
  >();

  const [editingItem, setEditingItem] = useState<CatalogItem | null>(null);
  const [deletingItem, setDeletingItem] = useState<CatalogItem | null>(null);
  const [installingServerIds, setInstallingServerIds] = useState<Set<string>>(
    new Set(),
  );
  const [installingItemId, setInstallingItemId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCatalogItem, setSelectedCatalogItem] =
    useState<CatalogItem | null>(null);
  const [catalogItemForReinstall, setCatalogItemForReinstall] =
    useState<CatalogItem | null>(null);
  const [isTeamMode, setIsTeamMode] = useState(false);
  const [noAuthCatalogItem, setNoAuthCatalogItem] =
    useState<CatalogItem | null>(null);
  const [localServerCatalogItem, setLocalServerCatalogItem] =
    useState<CatalogItem | null>(null);

  const { data: userIsMcpServerAdmin } = useHasPermissions({
    mcpServer: ["admin"],
  });

  // Poll installation status for the first installing server
  const mcpServerInstallationStatus = useMcpServerInstallationStatus(
    Array.from(installingServerIds)[0] ?? null,
  );

  // Remove server from installing set when installation completes
  useEffect(() => {
    const firstInstallingId = Array.from(installingServerIds)[0];
    if (firstInstallingId && mcpServerInstallationStatus.data === "success") {
      setInstallingServerIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(firstInstallingId);
        return newSet;
      });
    }
  }, [mcpServerInstallationStatus.data, installingServerIds]);

  const handleInstallRemoteServer = async (
    catalogItem: CatalogItem,
    teamMode: boolean,
  ) => {
    setIsTeamMode(teamMode);

    // Check if this is a remote server with user configuration
    if (
      catalogItem.serverType === "remote" &&
      catalogItem.userConfig &&
      Object.keys(catalogItem.userConfig).length > 0
    ) {
      setSelectedCatalogItem(catalogItem);
      openDialog("remote-install");
      return;
    }

    // Check if this server requires OAuth authentication
    if (catalogItem.oauthConfig) {
      setSelectedCatalogItem(catalogItem);
      openDialog("oauth");
      return;
    }

    // For servers without configuration, install directly
    setInstallingItemId(catalogItem.id);
    await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: catalogItem.id,
      teams: [],
    });
    setInstallingItemId(null);
  };

  const handleInstallRemoteServerTeam = async (catalogItem: CatalogItem) => {
    await handleInstallRemoteServer(catalogItem, true);
  };

  const handleInstallLocalServerTeam = async (catalogItem: CatalogItem) => {
    setIsTeamMode(true);
    setLocalServerCatalogItem(catalogItem);
    openDialog("local-install");
  };

  const handleInstallLocalServer = async (catalogItem: CatalogItem) => {
    setIsTeamMode(false);

    // Check if we need to show configuration dialog
    const hasUserConfig =
      catalogItem.userConfig && Object.keys(catalogItem.userConfig).length > 0;
    const hasPromptedEnvVars = catalogItem.localConfig?.environment?.some(
      (env) => env.promptOnInstallation === true,
    );

    if (hasUserConfig || hasPromptedEnvVars) {
      // Show configuration dialog
      setLocalServerCatalogItem(catalogItem);
      openDialog("local-install");
      return;
    }

    // No configuration needed, install directly
    try {
      setInstallingItemId(catalogItem.id);
      const installedServer = await installMutation.mutateAsync({
        name: catalogItem.name,
        catalogId: catalogItem.id,
        teams: [],
        dontShowToast: true,
      });
      // Track the installed server for polling
      if (installedServer?.id) {
        setInstallingServerIds((prev) => new Set(prev).add(installedServer.id));
      }
    } finally {
      setInstallingItemId(null);
    }
  };

  const handleNoAuthConfirm = async (teams: string[] = []) => {
    if (!noAuthCatalogItem) return;

    setInstallingItemId(noAuthCatalogItem.id);
    await installMutation.mutateAsync({
      name: noAuthCatalogItem.name,
      catalogId: noAuthCatalogItem.id,
      teams,
    });
    closeDialog("no-auth");
    setNoAuthCatalogItem(null);
    setInstallingItemId(null);
  };

  const handleLocalServerInstallConfirm = async (
    userConfigValues: Record<string, string>,
    environmentValues: Record<string, string>,
    teams?: string[],
  ) => {
    if (!localServerCatalogItem) return;

    setInstallingItemId(localServerCatalogItem.id);
    const installedServer = await installMutation.mutateAsync({
      name: localServerCatalogItem.name,
      catalogId: localServerCatalogItem.id,
      teams: teams || [],
      userConfigValues,
      environmentValues,
      dontShowToast: true,
    });

    // Track the installed server for polling
    if (installedServer?.id) {
      setInstallingServerIds((prev) => new Set(prev).add(installedServer.id));
    }

    closeDialog("local-install");
    setLocalServerCatalogItem(null);
    setInstallingItemId(null);
  };

  const handleRemoteServerInstallConfirm = async (
    catalogItem: CatalogItem,
    metadata?: Record<string, unknown>,
    teams: string[] = [],
  ) => {
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
    setInstallingItemId(null);
  };

  const handleOAuthConfirm = async (teams: string[] = []) => {
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
      toast.error("Failed to initiate OAuth flow");
    }
  };

  // Aggregate all installations of the same catalog item
  const getAggregatedInstallation = (catalogId: string) => {
    const servers = installedServers?.filter(
      (server) => server.catalogId === catalogId,
    );

    if (!servers || servers.length === 0) return undefined;

    // If only one server, return it as-is (but check for team auth ownership)
    if (servers.length === 1) {
      const server = servers[0];
      return {
        ...server,
        currentUserHasTeamAuth:
          server.authType === "team" && server.ownerId === currentUserId,
      };
    }

    // Use the first server with users as the base, or just first server
    const baseServer =
      servers.find((s) => s.users && s.users.length > 0) || servers[0];

    // Aggregate multiple servers
    const aggregated = { ...baseServer };

    // Check if current user has a team-auth server
    const currentUserHasTeamAuth = servers.some(
      (s) => s.authType === "team" && s.ownerId === currentUserId,
    );

    // Combine all unique users
    const allUsers = new Set<string>();
    const allUserDetails: Array<{
      userId: string;
      email: string;
      createdAt: string;
      serverId: string; // Track which server this user belongs to
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
            allUserDetails.push({
              ...userDetail,
              serverId: server.id, // Include the actual server ID
            });
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
      serverId: string; // Track which server this team belongs to
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
            allTeamDetails.push({
              ...teamDetail,
              serverId: server.id, // Include the actual server ID
            });
          }
        }
      }
    }

    aggregated.users = Array.from(allUsers);
    aggregated.userDetails = allUserDetails;
    aggregated.teams = Array.from(allTeams);
    aggregated.teamDetails = allTeamDetails;

    return {
      ...aggregated,
      currentUserHasTeamAuth,
    };
  };

  const handleReinstall = (catalogItem: CatalogItem) => {
    // Show confirmation dialog before reinstalling
    setCatalogItemForReinstall(catalogItem);
    openDialog("reinstall");
  };

  const handleReinstallConfirm = async () => {
    if (!catalogItemForReinstall) return;

    // For local servers, find the current user's specific installation
    // For remote servers, find any installation (there should be only one per catalog)
    let installedServer: InstalledServer | undefined;
    if (catalogItemForReinstall.serverType === "local" && currentUserId) {
      installedServer = installedServers?.find(
        (server) =>
          server.catalogId === catalogItemForReinstall.id &&
          server.ownerId === currentUserId &&
          server.authType === "personal",
      );
    } else {
      installedServer = installedServers?.find(
        (server) => server.catalogId === catalogItemForReinstall.id,
      );
    }

    if (!installedServer) {
      toast.error("Server not found, cannot reinstall");
      closeDialog("reinstall");
      setCatalogItemForReinstall(null);
      return;
    }

    closeDialog("reinstall");

    // Delete the installed server using its server ID
    await deleteMutation.mutateAsync({
      id: installedServer.id,
      name: catalogItemForReinstall.name,
    });

    // Then reinstall (for local servers, this will prompt for credentials again)
    if (catalogItemForReinstall.serverType === "local") {
      await handleInstallLocalServer(catalogItemForReinstall);
    } else {
      await handleInstallRemoteServer(catalogItemForReinstall, false);
    }

    setCatalogItemForReinstall(null);
  };

  const sortInstalledFirst = (items: CatalogItem[]) =>
    [...items].sort((a, b) => {
      const aIsRemote = a.serverType === "remote";
      const bIsRemote = b.serverType === "remote";

      // First sort by server type (remote before local)
      if (aIsRemote && !bIsRemote) return -1;
      if (!aIsRemote && bIsRemote) return 1;

      return 0;
    });

  const filterCatalogItems = (items: CatalogItem[], query: string) => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return items;

    return items.filter((item) => {
      const labelText =
        typeof item.name === "string" ? item.name.toLowerCase() : "";
      return (
        item.name.toLowerCase().includes(normalizedQuery) ||
        labelText.includes(normalizedQuery)
      );
    });
  };

  const filteredCatalogItems = sortInstalledFirst(
    filterCatalogItems(catalogItems || [], searchQuery),
  );

  const getInstalledServerInfo = (item: CatalogItem) => {
    const installedServer = getAggregatedInstallation(item.id);
    const isInstallInProgress =
      installedServer && installingServerIds.has(installedServer.id);

    // For local servers, count installations and check ownership
    const localServers =
      installedServers?.filter(
        (server) =>
          server.serverType === "local" && server.catalogId === item.id,
      ) || [];
    const currentUserLocalServerInstallation = currentUserId
      ? localServers.find(
          (server) =>
            server.ownerId === currentUserId && server.authType === "personal",
        )
      : undefined;
    const currentUserInstalledLocalServer = Boolean(
      currentUserLocalServerInstallation,
    );
    const currentUserHasLocalTeamInstallation = Boolean(
      localServers.some((server) => server.authType === "team"),
    );

    return {
      installedServer,
      isInstallInProgress,
      currentUserInstalledLocalServer,
      currentUserHasLocalTeamInstallation,
      currentUserLocalServerInstallation,
    };
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search MCP servers by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          onClick={() =>
            userIsMcpServerAdmin
              ? openDialog("create")
              : openDialog("custom-request")
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          {userIsMcpServerAdmin
            ? "Add MCP Server"
            : "Request to add custom MCP Server"}
        </Button>
      </div>
      <div className="space-y-4">
        {filteredCatalogItems.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 items-start">
            {filteredCatalogItems.map((item) => {
              const serverInfo = getInstalledServerInfo(item);
              return (
                <McpServerCard
                  variant={item.serverType === "remote" ? "remote" : "local"}
                  key={item.id}
                  item={item}
                  installedServer={serverInfo.installedServer}
                  installingItemId={installingItemId}
                  installationStatus={
                    serverInfo.isInstallInProgress
                      ? mcpServerInstallationStatus.data
                      : undefined
                  }
                  onInstallRemoteServer={() =>
                    handleInstallRemoteServer(item, false)
                  }
                  onInstallRemoteServerTeam={() =>
                    handleInstallRemoteServerTeam(item)
                  }
                  onInstallLocalServer={() => handleInstallLocalServer(item)}
                  onInstallLocalServerTeam={() =>
                    handleInstallLocalServerTeam(item)
                  }
                  onReinstall={() => handleReinstall(item)}
                  onEdit={() => setEditingItem(item)}
                  onDelete={() => setDeletingItem(item)}
                  currentUserInstalledLocalServer={
                    serverInfo.currentUserInstalledLocalServer
                  }
                  currentUserHasLocalTeamInstallation={
                    serverInfo.currentUserHasLocalTeamInstallation
                  }
                  currentUserLocalServerInstallation={
                    serverInfo.currentUserLocalServerInstallation
                  }
                />
              );
            })}
          </div>
        ) : (
          <div className="py-8 text-center">
            <p className="text-muted-foreground">
              {searchQuery.trim()
                ? `No MCP servers match "${searchQuery}".`
                : "No MCP servers found."}
            </p>
          </div>
        )}
      </div>

      <CreateCatalogDialog
        isOpen={isDialogOpened("create")}
        onClose={() => closeDialog("create")}
      />

      <CustomServerRequestDialog
        isOpen={isDialogOpened("custom-request")}
        onClose={() => closeDialog("custom-request")}
      />

      <EditCatalogDialog
        item={editingItem}
        onClose={() => {
          const item = editingItem;

          if (item) {
            setEditingItem(null);
            const serverInfo = getInstalledServerInfo(item);
            if (serverInfo.installedServer?.reinstallRequired) {
              handleReinstall(item);
            }
          }
        }}
      />

      <DeleteCatalogDialog
        item={deletingItem}
        onClose={() => setDeletingItem(null)}
        installationCount={
          deletingItem
            ? installedServers?.filter(
                (server) => server.catalogId === deletingItem.id,
              ).length || 0
            : 0
        }
      />

      <RemoteServerInstallDialog
        isOpen={isDialogOpened("remote-install")}
        onClose={() => {
          closeDialog("remote-install");
          setSelectedCatalogItem(null);
          setIsTeamMode(false);
        }}
        onConfirm={handleRemoteServerInstallConfirm}
        catalogItem={selectedCatalogItem}
        isInstalling={installMutation.isPending}
        isTeamMode={isTeamMode}
      />

      <OAuthConfirmationDialog
        open={isDialogOpened("oauth")}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog("oauth");
          }
        }}
        serverName={selectedCatalogItem?.name || ""}
        onConfirm={handleOAuthConfirm}
        onCancel={() => {
          closeDialog("oauth");
          setSelectedCatalogItem(null);
          setIsTeamMode(false);
        }}
        isTeamMode={isTeamMode}
        catalogId={selectedCatalogItem?.id}
        installedServers={installedServers}
      />

      <ReinstallConfirmationDialog
        isOpen={isDialogOpened("reinstall")}
        onClose={() => {
          closeDialog("reinstall");
          setCatalogItemForReinstall(null);
        }}
        isRemoteServer={catalogItemForReinstall?.serverType === "remote"}
        onConfirm={handleReinstallConfirm}
        serverName={catalogItemForReinstall?.name || ""}
        isReinstalling={installMutation.isPending}
      />

      <NoAuthInstallDialog
        isOpen={isDialogOpened("no-auth")}
        onClose={() => {
          closeDialog("no-auth");
          setNoAuthCatalogItem(null);
        }}
        onInstall={handleNoAuthConfirm}
        catalogItem={noAuthCatalogItem}
        isInstalling={installMutation.isPending}
      />

      <LocalServerInstallDialog
        isOpen={isDialogOpened("local-install")}
        onClose={() => {
          closeDialog("local-install");
          setLocalServerCatalogItem(null);
        }}
        onConfirm={handleLocalServerInstallConfirm}
        catalogItem={localServerCatalogItem}
        isInstalling={installMutation.isPending}
        authType={isTeamMode ? "team" : "personal"}
      />
    </div>
  );
}
