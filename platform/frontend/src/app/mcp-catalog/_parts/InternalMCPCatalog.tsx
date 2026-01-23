"use client";

import { ARCHESTRA_MCP_CATALOG_ID } from "@shared";
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
import { useInternalMcpCatalogSuspense } from "@/lib/internal-mcp-catalog.query";
import {
  useDeleteMcpServer,
  useInstallMcpServer,
  useMcpServers,
  useRestartAllMcpServerInstallations,
} from "@/lib/mcp-server.query";
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

  const { data: catalogItems } = useInternalMcpCatalogSuspense({ initialData });
  const [installingServerIds, setInstallingServerIds] = useState<Set<string>>(
    new Set(),
  );
  const { data: installedServers } = useMcpServers({
    initialData: initialInstalledServers,
    hasInstallingServers: installingServerIds.size > 0,
  });
  const installMutation = useInstallMcpServer();
  const deleteMutation = useDeleteMcpServer();
  const restartAllMutation = useRestartAllMcpServerInstallations();
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
  const [detailsServerName, setDetailsServerName] = useState<string | null>(
    null,
  );
  const { data: detailsServerData } = useMcpRegistryServer(detailsServerName);

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
            } else if (server.localInstallationStatus === "error") {
              toast.error(`Failed to install ${server.name}`);
            }
          }
        });
      }
    }
  }, [installedServers, installingServerIds, queryClient]);

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

  const handleNoAuthConfirm = async (result: NoAuthInstallResult) => {
    if (!noAuthCatalogItem) return;

    setInstallingItemId(noAuthCatalogItem.id);
    await installMutation.mutateAsync({
      name: noAuthCatalogItem.name,
      catalogId: noAuthCatalogItem.id,
      teamId: result.teamId ?? undefined,
    });
    closeDialog("no-auth");
    setNoAuthCatalogItem(null);
    setInstallingItemId(null);
  };

  const handleLocalServerInstallConfirm = async (
    installResult: LocalServerInstallResult,
  ) => {
    if (!localServerCatalogItem) return;

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
    }

    closeDialog("local-install");
    setLocalServerCatalogItem(null);
    setInstallingItemId(null);
  };

  const handleRemoteServerInstallConfirm = async (
    catalogItem: CatalogItem,
    result: RemoteServerInstallResult,
  ) => {
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
  };

  const handleOAuthConfirm = async (result: OAuthInstallResult) => {
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

      // Store state in session storage for the callback
      sessionStorage.setItem("oauth_state", state);
      sessionStorage.setItem("oauth_catalog_id", selectedCatalogItem.id);
      // Store teamId for use after OAuth callback
      if (result.teamId) {
        sessionStorage.setItem("oauth_team_id", result.teamId);
      } else {
        sessionStorage.removeItem("oauth_team_id");
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
          server.ownerId === currentUserId,
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
      const getPriority = (serverType: string) => {
        if (serverType === "builtin") return 0;
        if (serverType === "remote") return 1;
        return 2; // local
      };

      const priorityDiff =
        getPriority(a.serverType) - getPriority(b.serverType);
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
        <div className="flex gap-3">
          <Button
            onClick={() =>
              userIsMcpServerAdmin
                ? openDialog("create")
                : openDialog("custom-request")
            }
            className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white shadow-lg hover:shadow-xl transition-all duration-200"
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
            className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 hover:from-green-500/20 hover:to-emerald-500/20 border-green-500/50 hover:border-green-500 transition-all duration-200 shadow-sm hover:shadow-md"
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
                  onInstallLocalServer={() => handleInstallLocalServer(item)}
                  onReinstall={() => handleReinstall(item)}
                  onRestartAll={() => {
                    restartAllMutation.mutate({
                      catalogId: item.id,
                      name: item.name,
                    });
                  }}
                  onEdit={() => setEditingItem(item)}
                  onDetails={() => {
                    setDetailsServerName(item.name);
                  }}
                  onDelete={() => setDeletingItem(item)}
                  onCancelInstallation={handleCancelInstallation}
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

      {localServerCatalogItem && (
        <LocalServerInstallDialog
          isOpen={isDialogOpened("local-install")}
          onClose={() => {
            closeDialog("local-install");
            setLocalServerCatalogItem(null);
          }}
          onConfirm={handleLocalServerInstallConfirm}
          catalogItem={localServerCatalogItem}
          isInstalling={installMutation.isPending}
        />
      )}
    </div>
  );
}
