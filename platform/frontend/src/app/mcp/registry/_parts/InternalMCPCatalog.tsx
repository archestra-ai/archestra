"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  isPlaywrightCatalogItem,
  MCP_CATALOG_INSTALL_QUERY_PARAM,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
} from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DebouncedInput } from "@/components/debounced-input";
import {
  OAuthConfirmationDialog,
  type OAuthInstallResult,
} from "@/components/oauth-confirmation-dialog";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useDialogs } from "@/lib/dialog.hook";
import { useMcpRegistryServer } from "@/lib/external-mcp-catalog.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import {
  useInstallMcpServer,
  useMcpDeploymentStatuses,
  useMcpServers,
  useReauthenticateMcpServer,
  useReinstallMcpServer,
} from "@/lib/mcp-server.query";
import { useInitiateOAuth } from "@/lib/oauth.query";
import {
  clearInstallationCompleteCatalogId,
  clearPendingAfterEnvVars,
  getOAuthInstallationCompleteCatalogId,
  getOAuthPendingAfterEnvVars,
  setOAuthCatalogId,
  setOAuthEnvironmentValues,
  setOAuthIsFirstInstallation,
  setOAuthMcpServerId,
  setOAuthPendingAfterEnvVars,
  setOAuthReturnUrl,
  setOAuthServerType,
  setOAuthState,
  setOAuthTeamId,
} from "@/lib/oauth-session";
import websocketService from "@/lib/websocket";
import { CreateCatalogDialog } from "./create-catalog-dialog";
import { CustomServerRequestDialog } from "./custom-server-request-dialog";
import { DeleteCatalogDialog } from "./delete-catalog-dialog";
import { DetailsDialog } from "./details-dialog";
import { EditCatalogDialog } from "./edit-catalog-dialog";
import {
  LocalServerInstallDialog,
  type LocalServerInstallResult,
} from "./local-server-install-dialog";
import { ManageUsersDialog } from "./manage-users-dialog";
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
  const reauthMutation = useReauthenticateMcpServer();
  const initiateOAuthMutation = useInitiateOAuth();
  const deploymentStatuses = useMcpDeploymentStatuses();
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
    | "manage"
  >();

  const [editingItem, setEditingItem] = useState<CatalogItem | null>(null);
  const [deletingItem, setDeletingItem] = useState<CatalogItem | null>(null);
  const [installingItemId, setInstallingItemId] = useState<string | null>(null);

  // Deep-link manage connections dialog state
  const [manageCatalogId, setManageCatalogId] = useState<string | null>(null);
  // Pre-selected team ID when adding a shared connection from manage dialog
  const [preselectedTeamId, setPreselectedTeamId] = useState<string | null>(
    null,
  );
  // When true, install dialog hides the team selector (personal connection only)
  const [installPersonalOnly, setInstallPersonalOnly] = useState(false);

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
  // Track server ID for re-authentication (preserves tool assignments)
  const [reauthServerId, setReauthServerId] = useState<string | null>(null);
  const [detailsServerName, setDetailsServerName] = useState<string | null>(
    null,
  );
  const { data: detailsServerData } = useMcpRegistryServer(detailsServerName);

  const { data: _userIsMcpServerAdmin } = useHasPermissions({
    mcpServerInstallation: ["admin"],
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
              // Force immediate deployment status refresh via WebSocket
              websocketService.send({
                type: "subscribe_mcp_deployment_statuses",
                payload: {},
              });
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

                // Remove from first installation tracking
                if (firstInstallationServerIds.has(serverId)) {
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

  // Listen for create event from layout header button
  useEffect(() => {
    const handler = () => openDialog("create");
    window.addEventListener("mcp-registry:create", handler);
    return () => window.removeEventListener("mcp-registry:create", handler);
  }, [openDialog]);

  // Clear OAuth installation completion state
  useEffect(() => {
    const oauthCatalogId = getOAuthInstallationCompleteCatalogId();
    if (oauthCatalogId) {
      clearInstallationCompleteCatalogId();
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

  // Deep-link: handle ?reauth={catalogId} with optional ?server={serverId}
  // When server param is present, go straight to re-authentication (preserves tool assignments).
  // When only reauth param is present, open the manage connections dialog.
  // Uses window.history.replaceState instead of router.replace to avoid triggering
  // a searchParams change that would re-fire the effect and race with state updates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only trigger on searchParams changes, other deps are stable callbacks
  useEffect(() => {
    const reauthCatalogIdParam = searchParams.get(
      MCP_CATALOG_REAUTH_QUERY_PARAM,
    );
    if (!reauthCatalogIdParam) return;

    // Extract highlight param before clearing URL
    const serverIdParam = searchParams.get(MCP_CATALOG_SERVER_QUERY_PARAM);

    // Clear the manage/highlight params from URL without triggering a React re-render
    const params = new URLSearchParams(searchParams.toString());
    params.delete(MCP_CATALOG_REAUTH_QUERY_PARAM);
    params.delete(MCP_CATALOG_SERVER_QUERY_PARAM);
    const newUrl = params.toString()
      ? `${pathname}?${params.toString()}`
      : pathname;
    window.history.replaceState(null, "", newUrl);

    // When highlight param is present, skip manage dialog and go straight to reauth
    if (serverIdParam) {
      handleDeepLinkReauth(reauthCatalogIdParam, serverIdParam);
      return;
    }

    // Open the manage connections dialog
    setManageCatalogId(reauthCatalogIdParam);
    openDialog("manage");
  }, [searchParams]);

  const handleManageDialogClose = () => {
    closeDialog("manage");
    setManageCatalogId(null);
  };

  // Called to re-authenticate a highlighted credential in-place (preserves tool assignments)
  const handleDeepLinkReauth = (catalogId: string, serverId: string) => {
    const catalogItem = catalogItems?.find((item) => item.id === catalogId);
    if (!catalogItem) return;

    setReauthServerId(serverId);

    if (catalogItem.oauthConfig) {
      // OAuth server: go through OAuth flow with reauth context
      const hasUserConfig =
        catalogItem.userConfig &&
        Object.keys(catalogItem.userConfig).length > 0;

      if (!hasUserConfig) {
        // Pure OAuth — set reauth context and open OAuth confirmation
        setOAuthMcpServerId(serverId);
        setOAuthReturnUrl(window.location.href);
        setSelectedCatalogItem(catalogItem);
        openDialog("oauth");
        return;
      }

      // OAuth + user config fields: open remote install dialog in reauth mode
      setSelectedCatalogItem(catalogItem);
      openDialog("remote-install");
      return;
    }

    // Non-OAuth servers: open the appropriate dialog in reauth mode
    if (catalogItem.serverType === "local") {
      setLocalServerCatalogItem(catalogItem);
      openDialog("local-install");
    } else {
      setSelectedCatalogItem(catalogItem);
      openDialog("remote-install");
    }
  };

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
    // Check if this local server requires OAuth authentication
    if (catalogItem.oauthConfig) {
      // Check if there are prompted env vars that need collecting first
      const promptedEnvVars =
        catalogItem.localConfig?.environment?.filter(
          (env) => env.promptOnInstallation === true,
        ) || [];

      if (promptedEnvVars.length > 0) {
        // Has prompted env vars - open local install dialog first to collect them,
        // then initiate OAuth after dialog confirm
        setLocalServerCatalogItem(catalogItem);
        setOAuthPendingAfterEnvVars(true);
        openDialog("local-install");
      } else {
        // No env vars needed - go straight to OAuth flow
        // Store server type so OAuth callback knows this is a local server
        setOAuthServerType("local");
        setSelectedCatalogItem(catalogItem);
        openDialog("oauth");
      }
      return;
    }

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

  // Check if a catalog item needs any config dialogs, or can be installed directly
  const canDirectInstall = (catalogItem: CatalogItem) => {
    if (catalogItem.oauthConfig) return false;
    if (catalogItem.serverType === "remote") {
      const hasUserConfig =
        catalogItem.userConfig &&
        Object.keys(catalogItem.userConfig).length > 0;
      return !hasUserConfig;
    }
    // Local server: check for prompted env vars
    const promptedEnvVars =
      catalogItem.localConfig?.environment?.filter(
        (env) => env.promptOnInstallation === true,
      ) || [];
    return promptedEnvVars.length === 0;
  };

  // Install directly without opening a dialog (works for both personal and shared)
  const handleDirectInstall = async (
    catalogItem: CatalogItem,
    teamId?: string,
  ) => {
    setInstallingItemId(catalogItem.id);
    const result = await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: catalogItem.id,
      ...(teamId && { teamId }),
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

  // Add personal connection: skip dialog if no config needed, otherwise open dialog with personalOnly
  const handleAddPersonalConnection = (catalogItem: CatalogItem) => {
    if (canDirectInstall(catalogItem)) {
      handleDirectInstall(catalogItem);
    } else {
      setInstallPersonalOnly(true);
      if (catalogItem.serverType === "local") {
        handleInstallLocalServer(catalogItem);
      } else {
        handleInstallRemoteServer(catalogItem, false);
      }
    }
  };

  // Add shared connection: skip dialog if no config needed, otherwise open dialog with preselected team
  const handleAddSharedConnection = (
    catalogItem: CatalogItem,
    teamId: string,
  ) => {
    if (canDirectInstall(catalogItem)) {
      handleDirectInstall(catalogItem, teamId);
    } else {
      setPreselectedTeamId(teamId);
      if (catalogItem.serverType === "local") {
        handleInstallLocalServer(catalogItem);
      } else {
        handleInstallRemoteServer(catalogItem, false);
      }
    }
  };

  const handleNoAuthConfirm = async (result: NoAuthInstallResult) => {
    if (!noAuthCatalogItem) return;

    const catalogItem = noAuthCatalogItem;

    setInstallingItemId(catalogItem.id);
    await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: catalogItem.id,
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

    // Check if OAuth is pending after env vars collection
    if (getOAuthPendingAfterEnvVars() && localServerCatalogItem.oauthConfig) {
      clearPendingAfterEnvVars();
      // Store env vars and server type for use after OAuth callback
      setOAuthServerType("local");
      if (
        installResult.environmentValues &&
        Object.keys(installResult.environmentValues).length > 0
      ) {
        // Security: filter out secret-type env vars from sessionStorage.
        // In BYOS mode values are vault references (safe). In non-BYOS mode
        // actual secret values are excluded — they are handled server-side
        // via secretId or re-prompted on install.
        const secretKeys = new Set(
          (localServerCatalogItem.localConfig?.environment ?? [])
            .filter((e) => e.type === "secret")
            .map((e) => e.key),
        );
        const safeValues = installResult.isByosVault
          ? installResult.environmentValues
          : Object.fromEntries(
              Object.entries(installResult.environmentValues).filter(
                ([key]) => !secretKeys.has(key),
              ),
            );
        if (Object.keys(safeValues).length > 0) {
          setOAuthEnvironmentValues(safeValues);
        }
      }
      closeDialog("local-install");
      // Now initiate OAuth flow
      setSelectedCatalogItem(localServerCatalogItem);
      setLocalServerCatalogItem(null);
      openDialog("oauth");
      return;
    }

    // Re-authentication mode: update existing server credentials in-place
    if (reauthServerId) {
      await reauthMutation.mutateAsync({
        id: reauthServerId,
        name: localServerCatalogItem.name,
        environmentValues: installResult.environmentValues,
        isByosVault: installResult.isByosVault,
      });

      closeDialog("local-install");
      setLocalServerCatalogItem(null);
      setReauthServerId(null);
      return;
    }

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
    // For non-BYOS mode: Extract access_token from metadata if present and pass as accessToken
    // For BYOS mode: metadata contains vault references, pass via userConfigValues
    const accessToken =
      !result.isByosVault &&
      result.metadata?.access_token &&
      typeof result.metadata.access_token === "string"
        ? result.metadata.access_token
        : undefined;

    // Re-authentication mode: update existing server credentials in-place
    if (reauthServerId) {
      await reauthMutation.mutateAsync({
        id: reauthServerId,
        name: catalogItem.name,
        ...(accessToken && { accessToken }),
        ...(result.isByosVault && {
          userConfigValues: result.metadata as Record<string, string>,
        }),
        ...(!result.isByosVault &&
          !accessToken &&
          result.metadata && {
            userConfigValues: result.metadata as Record<string, string>,
          }),
        isByosVault: result.isByosVault,
      });

      closeDialog("remote-install");
      setSelectedCatalogItem(null);
      setReauthServerId(null);
      return;
    }

    setInstallingItemId(catalogItem.id);

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
      const { authorizationUrl, state } =
        await initiateOAuthMutation.mutateAsync({
          catalogId: selectedCatalogItem.id,
        });

      // Store state in session storage for the callback
      setOAuthState(state);
      setOAuthCatalogId(selectedCatalogItem.id);
      setOAuthTeamId(result.teamId ?? null);

      // If re-authenticating via OAuth, store reauth context
      if (reauthServerId) {
        setOAuthMcpServerId(reauthServerId);
        setOAuthReturnUrl(window.location.href);
        setReauthServerId(null);
      } else {
        // Store if this is a first installation (for auto-opening assignments dialog)
        const isFirstInstallation = !installedServers?.some(
          (s) => s.catalogId === selectedCatalogItem.id,
        );
        setOAuthIsFirstInstallation(isFirstInstallation);
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

  // Capture connected catalog IDs on first load to keep sort order stable.
  // Only update when the set of catalog IDs changes (new item added/removed),
  // not when connection status changes (which would cause items to jump around).
  const connectedCatalogIdsRef = useRef<Set<string> | null>(null);
  if (connectedCatalogIdsRef.current === null && installedServers) {
    connectedCatalogIdsRef.current = new Set(
      installedServers.map((s) => s.catalogId).filter(Boolean) as string[],
    );
  }

  const sortInstalledFirst = (items: CatalogItem[]) => {
    const connectedIds = connectedCatalogIdsRef.current;
    return [...items].sort((a, b) => {
      // Primary sort: connected (has installations) first — using stable snapshot
      const aConnected = connectedIds?.has(a.id) ? 0 : 1;
      const bConnected = connectedIds?.has(b.id) ? 0 : 1;
      if (aConnected !== bConnected) return aConnected - bConnected;

      // Secondary sort priority: builtin > remote > local
      const getPriority = (item: CatalogItem) => {
        if (item.serverType === "builtin" || isPlaywrightCatalogItem(item.id))
          return 0;
        if (item.serverType === "remote") return 1;
        return 2; // local
      };

      const priorityDiff = getPriority(a) - getPriority(b);
      if (priorityDiff !== 0) return priorityDiff;

      // Tertiary sort by createdAt (newest first)
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  };

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

  const allFilteredItems = sortInstalledFirst(
    filterCatalogItems(catalogItems || [], searchQueryFromUrl),
  ).filter((item) => item.id !== ARCHESTRA_MCP_CATALOG_ID);

  const draftItems = allFilteredItems.filter(
    (item) => item.scope === "personal",
  );
  const publishedItems = allFilteredItems.filter(
    (item) => item.scope !== "personal",
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
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <DebouncedInput
          placeholder="Search registry by name..."
          initialValue={searchQueryFromUrl}
          onChange={handleSearchChange}
          debounceMs={300}
          className="pl-9 h-11 bg-background/50 backdrop-blur-sm border-border/50 focus:border-primary/50 transition-colors"
        />
      </div>
      <div className="space-y-6">
        {draftItems.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Unpublished
            </h3>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {draftItems.map((item) => {
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
                    deploymentStatuses={deploymentStatuses}
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
                    onAddPersonalConnection={() =>
                      handleAddPersonalConnection(item)
                    }
                    onAddSharedConnection={(teamId) =>
                      handleAddSharedConnection(item, teamId)
                    }
                    isBuiltInPlaywright={isPlaywrightCatalogItem(item.id)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {publishedItems.length > 0 ? (
          <div className="space-y-3">
            {draftItems.length > 0 && (
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Published
              </h3>
            )}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {publishedItems.map((item) => {
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
                    deploymentStatuses={deploymentStatuses}
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
                    onAddPersonalConnection={() =>
                      handleAddPersonalConnection(item)
                    }
                    onAddSharedConnection={(teamId) =>
                      handleAddSharedConnection(item, teamId)
                    }
                    isBuiltInPlaywright={isPlaywrightCatalogItem(item.id)}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          draftItems.length === 0 && (
            <div className="py-8 text-center">
              <p className="text-muted-foreground">
                {searchQueryFromUrl.trim()
                  ? `No MCP servers match "${searchQueryFromUrl}".`
                  : "No MCP servers found."}
              </p>
            </div>
          )
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
          setReauthServerId(null);
          setPreselectedTeamId(null);
          setInstallPersonalOnly(false);
        }}
        onConfirm={handleRemoteServerInstallConfirm}
        catalogItem={selectedCatalogItem}
        isInstalling={installMutation.isPending || reauthMutation.isPending}
        isReauth={!!reauthServerId}
        preselectedTeamId={preselectedTeamId}
        personalOnly={installPersonalOnly}
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
          setReauthServerId(null);
          setPreselectedTeamId(null);
          setInstallPersonalOnly(false);
        }}
        catalogId={selectedCatalogItem?.id}
        preselectedTeamId={preselectedTeamId}
        personalOnly={installPersonalOnly}
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
          setPreselectedTeamId(null);
          setInstallPersonalOnly(false);
        }}
        onInstall={handleNoAuthConfirm}
        catalogItem={noAuthCatalogItem}
        isInstalling={installMutation.isPending}
        preselectedTeamId={preselectedTeamId}
        personalOnly={installPersonalOnly}
      />

      {localServerCatalogItem && (
        <LocalServerInstallDialog
          isOpen={isDialogOpened("local-install")}
          onClose={() => {
            closeDialog("local-install");
            setLocalServerCatalogItem(null);
            setReinstallServerId(null);
            setReinstallServerTeamId(null);
            setReauthServerId(null);
            setPreselectedTeamId(null);
            setInstallPersonalOnly(false);
          }}
          onConfirm={handleLocalServerInstallConfirm}
          catalogItem={localServerCatalogItem}
          isInstalling={
            installMutation.isPending ||
            reinstallMutation.isPending ||
            reauthMutation.isPending
          }
          isReinstall={!!reinstallServerId}
          existingTeamId={reinstallServerTeamId}
          isReauth={!!reauthServerId}
          preselectedTeamId={preselectedTeamId}
          personalOnly={installPersonalOnly}
        />
      )}

      {manageCatalogId && (
        <ManageUsersDialog
          isOpen={isDialogOpened("manage")}
          onClose={handleManageDialogClose}
          catalogId={manageCatalogId}
          onAddPersonalConnection={() => {
            const catalogItem = catalogItems?.find(
              (item) => item.id === manageCatalogId,
            );
            if (!catalogItem) return;
            handleAddPersonalConnection(catalogItem);
          }}
          onAddSharedConnection={(teamId) => {
            const catalogItem = catalogItems?.find(
              (item) => item.id === manageCatalogId,
            );
            if (!catalogItem) return;
            handleAddSharedConnection(catalogItem, teamId);
          }}
        />
      )}
    </div>
  );
}
