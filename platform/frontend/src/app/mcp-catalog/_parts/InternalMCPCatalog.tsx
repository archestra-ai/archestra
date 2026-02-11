"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  isPlaywrightCatalogItem,
  MCP_CATALOG_INSTALL_QUERY_PARAM,
} from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Cable, Plus, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { DebouncedInput } from "@/components/debounced-input";
import {
  OAuthConfirmationDialog,
  type OAuthInstallResult,
} from "@/components/oauth-confirmation-dialog";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useDialogs } from "@/lib/dialog.hook";
import { useMcpRegistryServer } from "@/lib/external-mcp-catalog.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import {
  useInstallMcpServer,
  useMcpServers,
  useReinstallMcpServer,
} from "@/lib/mcp-server.query";
import { useInitiateOAuth } from "@/lib/oauth.query";
import { CreateCatalogDialog } from "./create-catalog-dialog";
import { CustomServerRequestDialog } from "./custom-server-request-dialog";
import { DeleteCatalogDialog } from "./delete-catalog-dialog";
import { DetailsDialog } from "./details-dialog";
import { EditCatalogDialog } from "./edit-catalog-dialog";
import {
  LocalServerInstallDialog,
  type LocalServerInstallResult,
} from "./local-server-install-dialog";
import {
  type CatalogItem,
  type InstalledServer,
  McpServerCard,
} from "./mcp-server-card";
import {
  NoAuthInstallDialog,
  type NoAuthInstallResult,
} from "./no-auth-install-dialog";
import { ReinstallConfirmationDialog } from "./reinstall-confirmation-dialog";
import {
  RemoteServerInstallDialog,
  type RemoteServerInstallResult,
} from "./remote-server-install-dialog";

export function InternalMCPCatalog({
  initialData,
  installedServers: initialInstalledServers,
}: {
  initialData?: CatalogItem[];
  installedServers?: InstalledServer[];
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get search query from URL
  const searchQueryFromUrl = searchParams.get("search") || "";

  const { data: catalogItems } = useInternalMcpCatalog({ initialData });
  const [installingServerIds, setInstallingServerIds] = useState<Set<string>>(
    new Set(),
  );
  // Track server IDs that are first-time installations (for auto-opening assignments dialog)
  const [firstInstallationServerIds, setFirstInstallationServerIds] = useState<
    Set<string>
  >(new Set());
  const { data: installedServers } = useMcpServers({
    initialData: initialInstalledServers,
    hasInstallingServers: installingServerIds.size > 0,
  });
  const installMutation = useInstallMcpServer();
  const reinstallMutation = useReinstallMcpServer();
  const initiateOAuthMutation = useInitiateOAuth();
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
  const [installingItemId, setInstallingItemId] = useState<string | null>(null);

  // Update URL when search query changes (debounced via DebouncedInput)
  const handleSearchChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) {
        params.set("search", value);
      } else {
        params.delete("search");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );
  const [selectedCatalogItem, setSelectedCatalogItem] =
    useState<CatalogItem | null>(null);
  const [catalogItemForReinstall, setCatalogItemForReinstall] =
    useState<CatalogItem | null>(null);
  const [noAuthCatalogItem, setNoAuthCatalogItem] =
    useState<CatalogItem | null>(null);
  const [localServerCatalogItem, setLocalServerCatalogItem] =
    useState<CatalogItem | null>(null);
  // Track server ID when reinstalling (vs new installation)
  const [reinstallServerId, setReinstallServerId] = useState<string | null>(
    null,
  );
  // Track the team ID of the server being reinstalled (to pre-select credential type)
  const [reinstallServerTeamId, setReinstallServerTeamId] = useState<
    string | null
  >(null);
  const [detailsServerName, setDetailsServerName] = useState<string | null>(
    null,
  );
  const { data: detailsServerData } = useMcpRegistryServer(detailsServerName);

  // State for auto-opening assignments dialog after installation (stores catalog ID)
  const [autoOpenAssignmentsCatalogId, setAutoOpenAssignmentsCatalogId] =
    useState<string | null>(null);

  const { data: userIsMcpServerAdmin } = useHasPermissions({
    mcpServer: ["admin"],
  });

  const queryClient = useQueryClient();

  // Remove servers from installing set when installation completes (success or error)
  useEffect(() => {
    if (installedServers && installingServerIds.size > 0) {
      const completedServerIds = Array.from(installingServerIds).filter(
        (serverId) => {
          const server = installedServers.find((s) => s.id === serverId);
          return (
            server &&
            (server.localInstallationStatus === "success" ||
              server.localInstallationStatus === "error")
          );
        },
      );

      if (completedServerIds.length > 0) {
        setInstallingServerIds((prev) => {
          const newSet = new Set(prev);
          for (const id of completedServerIds) {
            newSet.delete(id);
          }
          return newSet;
        });

        // Show toasts for completed installations and invalidate tools queries
        completedServerIds.forEach((serverId) => {
          const server = installedServers.find((s) => s.id === serverId);
          if (server) {
            if (server.localInstallationStatus === "success") {
              toast.success(`Successfully installed ${server.name}`);
              // Invalidate tools queries to update "Tools assigned" count
              queryClient.invalidateQueries({
                queryKey: ["mcp-servers", server.id, "tools"],
              });
              queryClient.invalidateQueries({ queryKey: ["tools"] });
              queryClient.invalidateQueries({
                queryKey: ["tools", "unassigned"],
              });
              // Invalidate catalog tools so the manage-tools dialog shows discovered tools
              if (server.catalogId) {
                queryClient.invalidateQueries({
                  queryKey: ["mcp-catalog", server.catalogId, "tools"],
                });

                // Auto-open assignments dialog only for first installation
                if (firstInstallationServerIds.has(serverId)) {
                  const catalogItem = catalogItems?.find(
                    (item) => item.id === server.catalogId,
                  );
                  if (catalogItem) {
                    setAutoOpenAssignmentsCatalogId(catalogItem.id);
                  }
                  // Remove from first installation tracking
                  setFirstInstallationServerIds((prev) => {
                    const newSet = new Set(prev);
                    newSet.delete(serverId);
                    return newSet;
                  });
                }
              }
            }
            // Note: No error toast - the error banner on the card provides feedback
          }
        });
      }
    }
  }, [
    installedServers,
    installingServerIds,
    queryClient,
    catalogItems,
    firstInstallationServerIds,
  ]);

  // Resume polling for pending installations after page refresh
  useEffect(() => {
    if (installedServers) {
      const pendingServers = installedServers.filter(
        (s) =>
          s.localInstallationStatus === "pending" ||
          s.localInstallationStatus === "discovering-tools",
      );
      if (pendingServers.length > 0) {
        setInstallingServerIds(new Set(pendingServers.map((s) => s.id)));
      }
    }
  }, [installedServers]);

  // Check for OAuth installation completion and open assignments dialog
  useEffect(() => {
    const oauthCatalogId = sessionStorage.getItem(
      "oauth_installation_complete_catalog_id",
    );
    if (oauthCatalogId) {
      setAutoOpenAssignmentsCatalogId(oauthCatalogId);
      // Clear the flag after processing
      sessionStorage.removeItem("oauth_installation_complete_catalog_id");
    }
  }, []);

  // Deep-link: auto-open install dialog when ?install={catalogId} is present
  // biome-ignore lint/correctness/useExhaustiveDependencies: only trigger on searchParams/catalogItems changes, other deps are stable callbacks
  useEffect(() => {
    const installCatalogId = searchParams.get(MCP_CATALOG_INSTALL_QUERY_PARAM);
    if (!installCatalogId || !catalogItems) return;

    const catalogItem = catalogItems.find(
      (item) => item.id === installCatalogId,
    );
    if (!catalogItem) return;

    // Clear the install param from URL to prevent re-triggering on refresh
    const params = new URLSearchParams(searchParams.toString());
    params.delete(MCP_CATALOG_INSTALL_QUERY_PARAM);
    const newUrl = params.toString()
      ? `${pathname}?${params.toString()}`
      : pathname;
    router.replace(newUrl, { scroll: false });

    // Trigger the appropriate install dialog
    if (catalogItem.serverType === "local") {
      handleInstallLocalServer(catalogItem);
    } else {
      handleInstallRemoteServer(catalogItem, false);
    }
  }, [searchParams, catalogItems]);

  const handleInstallRemoteServer = async (
    catalogItem: CatalogItem,
    _teamMode: boolean,
  ) => {
    const hasUserConfig =
      catalogItem.userConfig && Object.keys(catalogItem.userConfig).length > 0;

    // Check if this server requires OAuth authentication if there is no user config
    if (!hasUserConfig && catalogItem.oauthConfig) {
      setSelectedCatalogItem(catalogItem);
      openDialog("oauth");
      return;
    }

    setSelectedCatalogItem(catalogItem);
    openDialog("remote-install");
  };

  const handleInstallLocalServer = async (catalogItem: CatalogItem) => {
    setLocalServerCatalogItem(catalogItem);
    openDialog("local-install");
  };

  const handleInstallPlaywright = async (catalogItem: CatalogItem) => {
    setInstallingItemId(catalogItem.id);
    const result = await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: catalogItem.id,
      dontShowToast: true,
    });

    const installedServerId = result?.installedServer?.id;
    if (installedServerId) {
      setInstallingServerIds((prev) => new Set(prev).add(installedServerId));
      const isFirstInstallation = !installedServers?.some(
        (s) => s.catalogId === catalogItem.id,
      );
      if (isFirstInstallation) {
        setFirstInstallationServerIds((prev) =>
          new Set(prev).add(installedServerId),
        );
      }
    }
    setInstallingItemId(null);
  };

  const handleNoAuthConfirm = async (result: NoAuthInstallResult) => {
    if (!noAuthCatalogItem) return;

    const catalogItem = noAuthCatalogItem;

    // Check if this is the first installation for this catalog item
    const isFirstInstallation = !installedServers?.some(
      (s) => s.catalogId === catalogItem.id,
    );

    setInstallingItemId(catalogItem.id);
    await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: catalogItem.id,
      teamId: result.teamId ?? undefined,
    });
    closeDialog("no-auth");
    setNoAuthCatalogItem(null);
    setInstallingItemId(null);

    // Auto-open assignments dialog only for the first installation
    if (isFirstInstallation) {
      setAutoOpenAssignmentsCatalogId(catalogItem.id);
    }
  };

  const handleLocalServerInstallConfirm = async (
    installResult: LocalServerInstallResult,
  ) => {
    if (!localServerCatalogItem) return;

    // Check if this is a reinstall (updating existing server) vs new installation
    if (reinstallServerId) {
      // Reinstall mode - call reinstall endpoint with new environment values
      setInstallingItemId(localServerCatalogItem.id);
      setInstallingServerIds((prev) => new Set(prev).add(reinstallServerId));
      closeDialog("local-install");
      setLocalServerCatalogItem(null);
      setReinstallServerId(null);
      setReinstallServerTeamId(null);

      const serverIdToReinstall = reinstallServerId;
      try {
        await reinstallMutation.mutateAsync({
          id: serverIdToReinstall,
          name: localServerCatalogItem.name,
          environmentValues: installResult.environmentValues,
          isByosVault: installResult.isByosVault,
          serviceAccount: installResult.serviceAccount,
        });
      } finally {
        // Clear installing state whether success or error
        setInstallingItemId(null);
        setInstallingServerIds((prev) => {
          const newSet = new Set(prev);
          newSet.delete(serverIdToReinstall);
          return newSet;
        });
      }
      return;
    }

    // New installation flow
    // Check if this is the first installation for this catalog item
    const isFirstInstallation = !installedServers?.some(
      (s) => s.catalogId === localServerCatalogItem.id,
    );

    setInstallingItemId(localServerCatalogItem.id);
    const result = await installMutation.mutateAsync({
      name: localServerCatalogItem.name,
      catalogId: localServerCatalogItem.id,
      environmentValues: installResult.environmentValues,
      isByosVault: installResult.isByosVault,
      teamId: installResult.teamId ?? undefined,
      serviceAccount: installResult.serviceAccount,
      dontShowToast: true,
    });

    // Track the installed server for polling
    const installedServerId = result?.installedServer?.id;
    if (installedServerId) {
      setInstallingServerIds((prev) => new Set(prev).add(installedServerId));
      // Track if this is first installation for opening assignments dialog later
      if (isFirstInstallation) {
        setFirstInstallationServerIds((prev) =>
          new Set(prev).add(installedServerId),
        );
      }
    }

    closeDialog("local-install");
    setLocalServerCatalogItem(null);
    setInstallingItemId(null);
  };

  const handleRemoteServerInstallConfirm = async (
    catalogItem: CatalogItem,
    result: RemoteServerInstallResult,
  ) => {
    // Check if this is the first installation for this catalog item
    const isFirstInstallation = !installedServers?.some(
      (s) => s.catalogId === catalogItem.id,
    );

    setInstallingItemId(catalogItem.id);

    // For non-BYOS mode: Extract access_token from metadata if present and pass as accessToken
    // For BYOS mode: metadata contains vault references, pass via userConfigValues
    const accessToken =
      !result.isByosVault &&
      result.metadata?.access_token &&
      typeof result.metadata.access_token === "string"
        ? result.metadata.access_token
        : undefined;

    await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: catalogItem.id,
      ...(accessToken && { accessToken }),
      ...(result.isByosVault && {
        userConfigValues: result.metadata as Record<string, string>,
      }),
      isByosVault: result.isByosVault,
      teamId: result.teamId ?? undefined,
    });
    setInstallingItemId(null);

    // Auto-open assignments dialog only for the first installation
    if (isFirstInstallation) {
      setAutoOpenAssignmentsCatalogId(catalogItem.id);
    }
  };

  const handleOAuthConfirm = async (result: OAuthInstallResult) => {
    if (!selectedCatalogItem) return;

    try {
      // Call backend to initiate OAuth flow
      const { authorizationUrl, state } =
        await initiateOAuthMutation.mutateAsync({
          catalogId: selectedCatalogItem.id,
        });

      // Store state in session storage for the callback
      sessionStorage.setItem("oauth_state", state);
      sessionStorage.setItem("oauth_catalog_id", selectedCatalogItem.id);
      // Store teamId for use after OAuth callback
      if (result.teamId) {
        sessionStorage.setItem("oauth_team_id", result.teamId);
      } else {
        sessionStorage.removeItem("oauth_team_id");
      }

      // Store if this is a first installation (for auto-opening assignments dialog)
      const isFirstInstallation = !installedServers?.some(
        (s) => s.catalogId === selectedCatalogItem.id,
      );
      if (isFirstInstallation) {
        sessionStorage.setItem("oauth_is_first_installation", "true");
      } else {
        sessionStorage.removeItem("oauth_is_first_installation");
      }

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

    // If only one server, return it as-is
    if (servers.length === 1) {
      return servers[0];
    }

    // Find current user's specific installation to use as base
    const currentUserServer = servers.find((s) => s.ownerId === currentUserId);

    // Prefer current user's server as base, otherwise use first server with users, or just first server
    const baseServer =
      currentUserServer ||
      servers.find((s) => s.users && s.users.length > 0) ||
      servers[0];

    // Aggregate multiple servers
    const aggregated = { ...baseServer };

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

    aggregated.users = Array.from(allUsers);
    aggregated.userDetails = allUserDetails;
    // Note: teamDetails is now a single object per server (many-to-one),
    // so we use the base server's teamDetails as-is

    return aggregated;
  };

  const handleReinstall = async (catalogItem: CatalogItem) => {
    // For local servers, find the current user's specific installation
    // For remote servers, find any installation (there should be only one per catalog)
    let installedServer: InstalledServer | undefined;
    if (catalogItem.serverType === "local" && currentUserId) {
      installedServer = installedServers?.find(
        (server) =>
          server.catalogId === catalogItem.id &&
          server.ownerId === currentUserId,
      );
    } else {
      installedServer = installedServers?.find(
        (server) => server.catalogId === catalogItem.id,
      );
    }

    if (!installedServer) {
      toast.error("Server not found, cannot reinstall");
      return;
    }

    // For local servers: check if there are prompted env vars that require user input
    // If so, open the install dialog directly in reinstall mode
    // For remote servers: show confirmation dialog (since they may need OAuth re-auth)
    if (catalogItem.serverType === "local") {
      const promptedEnvVars =
        catalogItem.localConfig?.environment?.filter(
          (env) => env.promptOnInstallation === true,
        ) || [];

      if (promptedEnvVars.length > 0) {
        // Has prompted env vars - open dialog to collect values (reinstall mode)
        setLocalServerCatalogItem(catalogItem);
        setReinstallServerId(installedServer.id);
        setReinstallServerTeamId(installedServer.teamId ?? null);
        openDialog("local-install");
      } else {
        // No prompted env vars - reinstall directly
        // Set installing state for immediate UI feedback (progress bar)
        setInstallingItemId(catalogItem.id);
        setInstallingServerIds((prev) => new Set(prev).add(installedServer.id));
        try {
          await reinstallMutation.mutateAsync({
            id: installedServer.id,
            name: catalogItem.name,
          });
        } finally {
          // Clear installing state whether success or error
          setInstallingItemId(null);
          setInstallingServerIds((prev) => {
            const newSet = new Set(prev);
            newSet.delete(installedServer.id);
            return newSet;
          });
        }
      }
    } else {
      // Remote server - show confirmation dialog (may need OAuth re-auth)
      setCatalogItemForReinstall(catalogItem);
      openDialog("reinstall");
    }
  };

  const handleReinstallConfirm = async () => {
    if (!catalogItemForReinstall) return;

    // Find the installed server for this remote catalog item
    const installedServer = installedServers?.find(
      (server) => server.catalogId === catalogItemForReinstall.id,
    );

    if (!installedServer) {
      toast.error("Server not found, cannot reinstall");
      closeDialog("reinstall");
      setCatalogItemForReinstall(null);
      return;
    }

    closeDialog("reinstall");

    // Remote server - reinstall directly
    // Set installing state for immediate UI feedback (progress bar)
    setInstallingItemId(catalogItemForReinstall.id);
    setInstallingServerIds((prev) => new Set(prev).add(installedServer.id));
    try {
      await reinstallMutation.mutateAsync({
        id: installedServer.id,
        name: catalogItemForReinstall.name,
      });
    } finally {
      // Clear installing state whether success or error
      setInstallingItemId(null);
      setInstallingServerIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(installedServer.id);
        return newSet;
      });
    }

    setCatalogItemForReinstall(null);
  };

  const handleCancelInstallation = (serverId: string) => {
    // Remove server from installing set to stop polling
    setInstallingServerIds((prev) => {
      const newSet = new Set(prev);
      newSet.delete(serverId);
      return newSet;
    });
  };

  const sortInstalledFirst = (items: CatalogItem[]) =>
    [...items].sort((a, b) => {
      // Sort priority: builtin > remote > local
      const getPriority = (item: CatalogItem) => {
        if (item.serverType === "builtin" || isPlaywrightCatalogItem(item.id))
          return 0;
        if (item.serverType === "remote") return 1;
        return 2; // local
      };

      const priorityDiff = getPriority(a) - getPriority(b);
      if (priorityDiff !== 0) return priorityDiff;

      // Secondary sort by createdAt (newest first)
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
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
    filterCatalogItems(catalogItems || [], searchQueryFromUrl),
  ).filter((item) => item.id !== ARCHESTRA_MCP_CATALOG_ID);

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
      ? localServers.find((server) => server.ownerId === currentUserId)
      : undefined;
    const currentUserInstalledLocalServer = Boolean(
      currentUserLocalServerInstallation,
    );

    return {
      installedServer,
      isInstallInProgress,
      currentUserInstalledLocalServer,
    };
  };

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            onClick={() =>
              userIsMcpServerAdmin
                ? openDialog("create")
                : openDialog("custom-request")
            }
            className="bg-linear-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white shadow-lg hover:shadow-xl transition-all duration-200"
          >
            <Plus className="mr-0.5 h-4 w-4" />
            {userIsMcpServerAdmin
              ? "Add MCP Server to the Registry"
              : "Request Custom MCP"}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/connection?tab=mcp";
            }}
            className="bg-linear-to-r from-green-500/10 to-emerald-500/10 hover:from-green-500/20 hover:to-emerald-500/20 border-green-500/50 hover:border-green-500 transition-all duration-200 shadow-sm hover:shadow-md whitespace-normal text-left h-auto"
          >
            <Cable className="mr-0.5 h-4 w-4" />
            Connect to the Unified MCP Gateway to access those servers
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <DebouncedInput
            placeholder="Search registry by name..."
            initialValue={searchQueryFromUrl}
            onChange={handleSearchChange}
            debounceMs={300}
            className="pl-9 h-11 bg-background/50 backdrop-blur-sm border-border/50 focus:border-primary/50 transition-colors"
          />
        </div>
      </div>
      <div className="space-y-4">
        {filteredCatalogItems.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredCatalogItems.map((item) => {
              const serverInfo = getInstalledServerInfo(item);
              return (
                <McpServerCard
                  variant={
                    item.serverType === "builtin"
                      ? "builtin"
                      : item.serverType === "remote"
                        ? "remote"
                        : "local"
                  }
                  key={item.id}
                  item={item}
                  installedServer={serverInfo.installedServer}
                  installingItemId={installingItemId}
                  installationStatus={
                    serverInfo.installedServer?.localInstallationStatus ||
                    undefined
                  }
                  onInstallRemoteServer={() =>
                    handleInstallRemoteServer(item, false)
                  }
                  onInstallLocalServer={() =>
                    isPlaywrightCatalogItem(item.id)
                      ? handleInstallPlaywright(item)
                      : handleInstallLocalServer(item)
                  }
                  onReinstall={() => handleReinstall(item)}
                  onEdit={() => setEditingItem(item)}
                  onDetails={() => {
                    setDetailsServerName(item.name);
                  }}
                  onDelete={() => setDeletingItem(item)}
                  onCancelInstallation={handleCancelInstallation}
                  autoOpenAssignmentsDialog={
                    autoOpenAssignmentsCatalogId === item.id
                  }
                  onAssignmentsDialogClose={() =>
                    setAutoOpenAssignmentsCatalogId(null)
                  }
                  isBuiltInPlaywright={isPlaywrightCatalogItem(item.id)}
                />
              );
            })}
          </div>
        ) : (
          <div className="py-8 text-center">
            <p className="text-muted-foreground">
              {searchQueryFromUrl.trim()
                ? `No MCP servers match "${searchQueryFromUrl}".`
                : "No MCP servers found."}
            </p>
          </div>
        )}
      </div>

      <CreateCatalogDialog
        isOpen={isDialogOpened("create")}
        onClose={() => closeDialog("create")}
        onSuccess={(createdItem) => {
          // Auto-open the appropriate install dialog based on server type
          if (createdItem.serverType === "local") {
            handleInstallLocalServer(createdItem);
          } else if (createdItem.serverType === "remote") {
            handleInstallRemoteServer(createdItem, false);
          }
          // For builtin servers, no connect dialog is needed
        }}
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
            // Only auto-trigger reinstall if not already in error state
            // (user should click "Reinstall Required" button to retry after error)
            const isInErrorState =
              serverInfo.installedServer?.localInstallationStatus === "error";
            if (
              serverInfo.installedServer?.reinstallRequired &&
              !isInErrorState
            ) {
              handleReinstall(item);
            }
          }
        }}
      />

      <DetailsDialog
        onClose={() => {
          setDetailsServerName(null);
        }}
        server={detailsServerData || null}
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
        }}
        onConfirm={handleRemoteServerInstallConfirm}
        catalogItem={selectedCatalogItem}
        isInstalling={installMutation.isPending}
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
        }}
        catalogId={selectedCatalogItem?.id}
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
        isReinstalling={reinstallMutation.isPending}
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

      {localServerCatalogItem && (
        <LocalServerInstallDialog
          isOpen={isDialogOpened("local-install")}
          onClose={() => {
            closeDialog("local-install");
            setLocalServerCatalogItem(null);
            setReinstallServerId(null);
            setReinstallServerTeamId(null);
          }}
          onConfirm={handleLocalServerInstallConfirm}
          catalogItem={localServerCatalogItem}
          isInstalling={
            installMutation.isPending || reinstallMutation.isPending
          }
          isReinstall={!!reinstallServerId}
          existingTeamId={reinstallServerTeamId}
        />
      )}
    </div>
  );
}
