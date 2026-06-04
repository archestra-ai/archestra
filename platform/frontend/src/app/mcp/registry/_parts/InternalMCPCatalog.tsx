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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  LabelFilterBadges,
  LabelKeyRowBase,
  LabelSelect,
  parseLabelsParam,
  serializeLabels,
} from "@/components/label-select";
import {
  OAuthConfirmationDialog,
  type OAuthInstallResult,
} from "@/components/oauth-confirmation-dialog";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useInitiateOAuth } from "@/lib/auth/oauth.query";
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
  setOAuthScope,
  setOAuthServerType,
  setOAuthState,
  setOAuthTeamId,
  setOAuthUserConfigValues,
} from "@/lib/auth/oauth-session";
import { useDialogs } from "@/lib/hooks/use-dialog";
import { useMcpRegistryServer } from "@/lib/mcp/external-mcp-catalog.query";
import {
  useInternalMcpCatalog,
  useMcpCatalogLabelKeys,
  useMcpCatalogLabelValues,
  useReinstallInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useInstallMcpServer,
  useMcpDeploymentStatuses,
  useMcpInstallationStatusCacheSync,
  useMcpServers,
  useReauthenticateMcpServer,
  useReinstallMcpServer,
} from "@/lib/mcp/mcp-server.query";
import { buildRemoteInstallCredentialPayload } from "@/lib/mcp/remote-install-payload";
import websocketService from "@/lib/websocket/websocket";
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
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { buildCloneFormValues } from "./mcp-catalog-form.utils";
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
import type { McpServerInstallScope } from "./select-mcp-server-credential-type-and-teams";

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
  const [restartingServerIds, setRestartingServerIds] = useState<Set<string>>(
    new Set(),
  );
  // Track server IDs that are first-time installations (for auto-opening assignments dialog)
  const [firstInstallationServerIds, setFirstInstallationServerIds] = useState<
    Set<string>
  >(new Set());
  const { data: installedServers } = useMcpServers({
    initialData: initialInstalledServers,
  });
  useMcpInstallationStatusCacheSync();
  const installMutation = useInstallMcpServer();
  const reinstallMutation = useReinstallMcpServer();
  // When the card requests an admin combined reinstall, remember which
  // catalog id needs its shared pod recreated *after* the per-install
  // mutation finishes. Cleared in finally blocks below.
  const [pendingCatalogReinstallId, setPendingCatalogReinstallId] = useState<
    string | null
  >(null);
  const reinstallCatalogMutation = useReinstallInternalMcpCatalogItem();
  const reauthMutation = useReauthenticateMcpServer();
  const initiateOAuthMutation = useInitiateOAuth();
  const deploymentStatuses = useMcpDeploymentStatuses();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

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
  const [cloneValues, setCloneValues] = useState<McpCatalogFormValues | null>(
    null,
  );
  const [cloneSourceId, setCloneSourceId] = useState<string | null>(null);
  const [deletingItem, setDeletingItem] = useState<CatalogItem | null>(null);
  const [installingItemId, setInstallingItemId] = useState<string | null>(null);

  // Deep-link manage connections dialog state
  const [manageCatalogId, setManageCatalogId] = useState<string | null>(null);
  // Pre-selected team ID when adding a shared connection from manage dialog
  const [preselectedTeamId, setPreselectedTeamId] = useState<string | null>(
    null,
  );
  // Pre-selected preset (child) catalog id when launching install from a
  // specific preset card on the Credentials page. Null = install into parent.
  const [preselectedCatalogId, setPreselectedCatalogId] = useState<
    string | null
  >(null);
  // When true, install dialog hides the team selector (personal connection only)
  const [installPersonalOnly, setInstallPersonalOnly] = useState(false);
  // When true, install dialog forces the organization-wide scope
  const [installOrgOnly, setInstallOrgOnly] = useState(false);

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
  // When reinstalling via the parent's card, this holds every install (parent +
  // child preset) that's flagged for reinstall — so handleReinstallConfirm can
  // fan out instead of only reinstalling the parent install. Each entry also
  // carries the preset label so the confirm dialog can list what will be
  // reinstalled.
  const [reinstallFlaggedTargets, setReinstallFlaggedTargets] = useState<
    Array<{ id: string; name: string; presetLabel: string | null }>
  >([]);
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
  // Track the scope of the server being reinstalled (to pre-select scope)
  const [reinstallServerScope, setReinstallServerScope] = useState<
    McpServerInstallScope | undefined
  >(undefined);
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
              if (!restartingServerIds.has(serverId)) {
                toast.success(`Successfully installed ${server.name}`);
              }
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
            if (
              restartingServerIds.has(serverId) &&
              (server.localInstallationStatus === "success" ||
                server.localInstallationStatus === "error")
            ) {
              setRestartingServerIds((prev) => {
                const newSet = new Set(prev);
                newSet.delete(serverId);
                return newSet;
              });
            }
            // Note: No error toast - the error banner on the card provides feedback
          }
        });
      }
    }
  }, [
    installedServers,
    installingServerIds,
    restartingServerIds,
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
    options?: {
      preserveInstallTarget?: boolean;
    },
  ) => {
    if (!options?.preserveInstallTarget) {
      setPreselectedTeamId(null);
      setPreselectedCatalogId(null);
      setInstallPersonalOnly(false);
      setInstallOrgOnly(false);
    }

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

  const handleInstallLocalServer = async (
    catalogItem: CatalogItem,
    options?: {
      preserveInstallTarget?: boolean;
    },
  ) => {
    if (!options?.preserveInstallTarget) {
      setPreselectedTeamId(null);
      setPreselectedCatalogId(null);
      setInstallPersonalOnly(false);
      setInstallOrgOnly(false);
    }

    // Check if this local server requires OAuth authentication
    if (catalogItem.oauthConfig) {
      // Check if there are prompted env vars that need collecting first
      const promptedEnvVars =
        catalogItem.localConfig?.environment?.filter(
          (env) => env.promptOnInstallation === true,
        ) || [];

      const promptableUserConfig = Object.values(
        catalogItem.userConfig ?? {},
      ).filter((field) => field.promptOnInstallation !== false);

      if (promptedEnvVars.length > 0 || promptableUserConfig.length > 0) {
        // Has prompted env vars or promptable user-config - open local install dialog first to collect them,
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
    // Local server: check for prompted env vars or promptable user-config
    const promptedEnvVars =
      catalogItem.localConfig?.environment?.filter(
        (env) => env.promptOnInstallation === true,
      ) || [];
    const promptableUserConfig = Object.values(
      catalogItem.userConfig ?? {},
    ).filter((field) => field.promptOnInstallation !== false);
    return promptedEnvVars.length === 0 && promptableUserConfig.length === 0;
  };

  // Install directly without opening a dialog (works for personal, team, and org)
  const handleDirectInstall = async (
    catalogItem: CatalogItem,
    target?: {
      teamId?: string;
      scope?: McpServerInstallScope;
      presetCatalogId?: string;
    },
  ) => {
    setInstallingItemId(catalogItem.id);
    const scope: McpServerInstallScope =
      target?.scope ?? (target?.teamId ? "team" : "personal");
    const result = await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: target?.presetCatalogId ?? catalogItem.id,
      scope,
      ...(scope === "team" && target?.teamId ? { teamId: target.teamId } : {}),
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
  const handleAddPersonalConnection = (
    catalogItem: CatalogItem,
    presetCatalogId?: string,
  ) => {
    if (canDirectInstall(catalogItem)) {
      handleDirectInstall(catalogItem, { presetCatalogId });
    } else {
      setPreselectedCatalogId(presetCatalogId ?? null);
      setInstallPersonalOnly(true);
      if (catalogItem.serverType === "local") {
        handleInstallLocalServer(catalogItem, {
          preserveInstallTarget: true,
        });
      } else {
        handleInstallRemoteServer(catalogItem, false, {
          preserveInstallTarget: true,
        });
      }
    }
  };

  // Add shared connection: skip dialog if no config needed, otherwise open dialog with preselected team
  const handleAddSharedConnection = (
    catalogItem: CatalogItem,
    teamId: string,
    presetCatalogId?: string,
  ) => {
    if (canDirectInstall(catalogItem)) {
      handleDirectInstall(catalogItem, {
        teamId,
        scope: "team",
        presetCatalogId,
      });
    } else {
      setPreselectedCatalogId(presetCatalogId ?? null);
      setPreselectedTeamId(teamId);
      if (catalogItem.serverType === "local") {
        handleInstallLocalServer(catalogItem, {
          preserveInstallTarget: true,
        });
      } else {
        handleInstallRemoteServer(catalogItem, false, {
          preserveInstallTarget: true,
        });
      }
    }
  };

  // Add organization connection: skip dialog if no config needed, otherwise
  // open dialog with scope locked to org.
  const handleAddOrgConnection = (
    catalogItem: CatalogItem,
    presetCatalogId?: string,
  ) => {
    if (canDirectInstall(catalogItem)) {
      handleDirectInstall(catalogItem, { scope: "org", presetCatalogId });
    } else {
      setPreselectedCatalogId(presetCatalogId ?? null);
      setInstallOrgOnly(true);
      if (catalogItem.serverType === "local") {
        handleInstallLocalServer(catalogItem, {
          preserveInstallTarget: true,
        });
      } else {
        handleInstallRemoteServer(catalogItem, false, {
          preserveInstallTarget: true,
        });
      }
    }
  };

  const handleNoAuthConfirm = async (result: NoAuthInstallResult) => {
    if (!noAuthCatalogItem) return;

    const catalogItem = noAuthCatalogItem;

    setInstallingItemId(catalogItem.id);
    await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: result.catalogId,
      scope: result.scope,
      teamId:
        result.scope === "team" ? (result.teamId ?? undefined) : undefined,
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
      if (
        installResult.userConfigValues &&
        Object.keys(installResult.userConfigValues).length > 0
      ) {
        setOAuthUserConfigValues({
          values: installResult.userConfigValues,
          userConfig: localServerCatalogItem.userConfig,
          isByosVault: installResult.isByosVault,
        });
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
        userConfigValues: installResult.userConfigValues,
        isByosVault: installResult.isByosVault,
      });

      closeDialog("local-install");
      setLocalServerCatalogItem(null);
      setReauthServerId(null);
      return;
    }

    // Check if this is a reinstall (updating existing server) vs new installation
    if (reinstallServerId) {
      // Reinstall mode - apply the submitted values to every flagged install
      // in the preset family (or just the single one if the card didn't pass a
      // list). Same env/userConfig bag is applied to each — operators can edit
      // per-install secrets afterwards from Manage credentials.
      const targetIds =
        reinstallFlaggedTargets.length > 0
          ? reinstallFlaggedTargets.map((t) => t.id)
          : [reinstallServerId];
      const targets = (installedServers ?? []).filter((s) =>
        targetIds.includes(s.id),
      );

      setInstallingItemId(localServerCatalogItem.id);
      setInstallingServerIds((prev) => {
        const next = new Set(prev);
        for (const t of targets) next.add(t.id);
        return next;
      });
      closeDialog("local-install");
      const catalogItemName = localServerCatalogItem.name;
      setLocalServerCatalogItem(null);
      setReinstallServerId(null);
      setReinstallServerTeamId(null);
      setReinstallServerScope(undefined);

      try {
        await Promise.all(
          targets.map((t) =>
            reinstallMutation.mutateAsync({
              id: t.id,
              name: catalogItemName,
              environmentValues: installResult.environmentValues,
              userConfigValues: installResult.userConfigValues,
              isByosVault: installResult.isByosVault,
              serviceAccount: installResult.serviceAccount,
            }),
          ),
        );
        if (pendingCatalogReinstallId) {
          // Per-install mutation persisted the admin's new prompted
          // values; now recreate the shared pod and cascade tool sync
          // to every tenant. If this step fails, the catalog flag stays
          // set and the next click will retry it directly (no modal,
          // since the admin's reinstall_required is already cleared).
          await reinstallCatalogMutation.mutateAsync(pendingCatalogReinstallId);
        }
      } finally {
        setInstallingItemId(null);
        setInstallingServerIds((prev) => {
          const next = new Set(prev);
          for (const t of targets) next.delete(t.id);
          return next;
        });
        setReinstallFlaggedTargets([]);
        setPendingCatalogReinstallId(null);
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
      catalogId: installResult.catalogId,
      environmentValues: installResult.environmentValues,
      userConfigValues: installResult.userConfigValues,
      isByosVault: installResult.isByosVault,
      scope: installResult.scope,
      teamId:
        installResult.scope === "team"
          ? (installResult.teamId ?? undefined)
          : undefined,
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
    const credentialPayload = buildRemoteInstallCredentialPayload(result);

    // Re-authentication mode: update existing server credentials in-place
    if (reauthServerId) {
      await reauthMutation.mutateAsync({
        id: reauthServerId,
        name: catalogItem.name,
        ...credentialPayload,
      });

      closeDialog("remote-install");
      setSelectedCatalogItem(null);
      setReauthServerId(null);
      return;
    }

    // Reinstall mode. Scope and team are fixed on the existing row, so
    // result.scope / result.teamId from the dialog are dropped here.
    if (reinstallServerId) {
      const target = (installedServers ?? []).find(
        (s) => s.id === reinstallServerId,
      );
      const targetId = reinstallServerId;
      setInstallingItemId(catalogItem.id);
      setInstallingServerIds((prev) => new Set(prev).add(targetId));
      closeDialog("remote-install");
      setSelectedCatalogItem(null);
      setReinstallServerId(null);

      try {
        await reinstallMutation.mutateAsync({
          id: targetId,
          name: target?.name ?? catalogItem.name,
          ...credentialPayload,
        });
      } finally {
        setInstallingItemId(null);
        setInstallingServerIds((prev) => {
          const next = new Set(prev);
          next.delete(targetId);
          return next;
        });
      }
      return;
    }

    setInstallingItemId(catalogItem.id);

    await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: result.catalogId,
      ...credentialPayload,
      scope: result.scope,
      teamId:
        result.scope === "team" ? (result.teamId ?? undefined) : undefined,
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
      setOAuthTeamId(result.scope === "team" ? (result.teamId ?? null) : null);
      setOAuthScope(result.scope);

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

  const handleReinstall = async (
    catalogItem: CatalogItem,
    flaggedInstalls?: Array<{
      id: string;
      name: string;
      presetLabel: string | null;
    }>,
    options?: { alsoReinstallCatalog?: boolean },
  ) => {
    // Preset-aware: the card passes every flagged install (parent + presets)
    // so the confirm step can fan out. If the caller didn't supply any (e.g.
    // legacy callers), fall back to the parent install.
    const flagged =
      flaggedInstalls && flaggedInstalls.length > 0
        ? (installedServers ?? []).filter((s) =>
            flaggedInstalls.some((f) => f.id === s.id),
          )
        : [];

    let installedServer: InstalledServer | undefined =
      flagged.find((s) => s.catalogId === catalogItem.id) ?? flagged[0];

    if (!installedServer) {
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
    }

    if (!installedServer) {
      toast.error("Server not found, cannot reinstall");
      return;
    }

    if (options?.alsoReinstallCatalog) {
      setPendingCatalogReinstallId(catalogItem.id);
    }

    setReinstallFlaggedTargets(
      flaggedInstalls && flaggedInstalls.length > 0
        ? flaggedInstalls
        : [
            {
              id: installedServer.id,
              name: installedServer.name,
              presetLabel: "default",
            },
          ],
    );

    // Open the install dialog in reinstall mode whenever there are prompted
    // fields the user owes values for — otherwise the simple "Reinstall
    // Required" confirmation modal is enough. Filters mirror each dialog's
    // own render filters so the two stay in sync; if they drift, the user
    // can be left clicking a confirm dialog when they actually owe input.
    const hasPromptedUserConfig = Object.values(
      catalogItem.userConfig ?? {},
    ).some(
      (field) => field.promptOnInstallation !== false && !field.promptOnPreset,
    );

    if (catalogItem.serverType === "local") {
      const hasPromptedEnv =
        !catalogItem.multitenant &&
        (catalogItem.localConfig?.environment?.some(
          (env) => env.promptOnInstallation !== false && !env.promptOnPreset,
        ) ??
          false);

      if (hasPromptedEnv || hasPromptedUserConfig) {
        setLocalServerCatalogItem(catalogItem);
        setReinstallServerId(installedServer.id);
        setReinstallServerTeamId(installedServer.teamId ?? null);
        setReinstallServerScope(
          (installedServer as unknown as { scope?: McpServerInstallScope })
            .scope,
        );
        openDialog("local-install");
      } else {
        setCatalogItemForReinstall(catalogItem);
        openDialog("reinstall");
      }
    } else if (hasPromptedUserConfig) {
      setSelectedCatalogItem(catalogItem);
      setReinstallServerId(installedServer.id);
      setReinstallServerTeamId(installedServer.teamId ?? null);
      setReinstallServerScope(
        (installedServer as unknown as { scope?: McpServerInstallScope }).scope,
      );
      openDialog("remote-install");
    } else {
      setCatalogItemForReinstall(catalogItem);
      openDialog("reinstall");
    }
  };

  const handleReinstallConfirm = async () => {
    if (!catalogItemForReinstall) return;

    // Resolve targets. If the card passed flagged ids, reinstall every one of
    // them; otherwise fall back to the parent install only.
    const targets =
      reinstallFlaggedTargets.length > 0
        ? (installedServers ?? []).filter((s) =>
            reinstallFlaggedTargets.some((t) => t.id === s.id),
          )
        : (() => {
            const fallback =
              catalogItemForReinstall.serverType === "local" && currentUserId
                ? installedServers?.find(
                    (server) =>
                      server.catalogId === catalogItemForReinstall.id &&
                      server.ownerId === currentUserId,
                  )
                : installedServers?.find(
                    (server) => server.catalogId === catalogItemForReinstall.id,
                  );
            return fallback ? [fallback] : [];
          })();

    if (targets.length === 0) {
      toast.error("Server not found, cannot reinstall");
      closeDialog("reinstall");
      setCatalogItemForReinstall(null);
      setReinstallFlaggedTargets([]);
      return;
    }

    closeDialog("reinstall");

    setInstallingItemId(catalogItemForReinstall.id);
    setInstallingServerIds((prev) => {
      const next = new Set(prev);
      for (const t of targets) next.add(t.id);
      return next;
    });

    try {
      await Promise.all(
        targets.map((t) =>
          reinstallMutation.mutateAsync({
            id: t.id,
            name: t.name,
          }),
        ),
      );
      if (pendingCatalogReinstallId) {
        await reinstallCatalogMutation.mutateAsync(pendingCatalogReinstallId);
      }
    } finally {
      setInstallingItemId(null);
      setInstallingServerIds((prev) => {
        const next = new Set(prev);
        for (const t of targets) next.delete(t.id);
        return next;
      });
      setCatalogItemForReinstall(null);
      setReinstallFlaggedTargets([]);
      setPendingCatalogReinstallId(null);
    }
  };

  const handleClone = (item: CatalogItem) => {
    setCloneValues(buildCloneFormValues(item));
    setCloneSourceId(item.id);
    openDialog("create");
  };

  const handleCancelInstallation = (serverId: string) => {
    // Remove server from installing set to stop polling
    setInstallingServerIds((prev) => {
      const newSet = new Set(prev);
      newSet.delete(serverId);
      return newSet;
    });
  };

  const handleRestartPodsStarted = (serverIds: string[]) => {
    if (serverIds.length === 0) return;
    setRestartingServerIds((prev) => {
      const next = new Set(prev);
      for (const serverId of serverIds) {
        next.add(serverId);
      }
      return next;
    });
  };

  const handleRestartPodsFailed = (serverIds: string[]) => {
    if (serverIds.length === 0) return;
    setRestartingServerIds((prev) => {
      const next = new Set(prev);
      for (const serverId of serverIds) {
        next.delete(serverId);
      }
      return next;
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

    return items.filter((item) =>
      item.name.toLowerCase().includes(normalizedQuery),
    );
  };

  const labelsParam = searchParams.get("labels");
  const parsedLabels = useMemo(
    () => parseLabelsParam(labelsParam),
    [labelsParam],
  );

  const filterByLabels = (
    items: CatalogItem[],
    labels: Record<string, string[]> | null,
  ) => {
    if (!labels || Object.keys(labels).length === 0) return items;
    return items.filter((item) =>
      Object.entries(labels).every(([key, values]) =>
        item.labels.some((l) => l.key === key && values.includes(l.value)),
      ),
    );
  };

  const allFilteredItems = sortInstalledFirst(
    filterByLabels(
      filterCatalogItems(catalogItems || [], searchQueryFromUrl),
      parsedLabels,
    ),
  ).filter((item) => item.id !== ARCHESTRA_MCP_CATALOG_ID);

  const personalItems = allFilteredItems.filter(
    (item) => item.scope === "personal",
  );
  const sharedItems = allFilteredItems.filter(
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

  const handleRemoveLabel = useCallback(
    (key: string, value: string) => {
      if (!parsedLabels) return;
      const updated = { ...parsedLabels };
      updated[key] = updated[key].filter((v) => v !== value);
      if (updated[key].length === 0) {
        delete updated[key];
      }
      const params = new URLSearchParams(searchParams.toString());
      const serialized = serializeLabels(updated);
      if (serialized) {
        params.set("labels", serialized);
      } else {
        params.delete("labels");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [parsedLabels, searchParams, router, pathname],
  );

  const handleClearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.delete("labels");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const hasLabelFilters = parsedLabels && Object.keys(parsedLabels).length > 0;
  const hasActiveFilters = Boolean(
    searchQueryFromUrl.trim() || hasLabelFilters,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <SearchInput
          objectNamePlural="MCP servers"
          searchFields={["name"]}
          value={searchQueryFromUrl}
          onSearchChange={handleSearchChange}
          syncQueryParams={false}
          debounceMs={300}
          inputClassName="w-full bg-background/50 backdrop-blur-sm border-border/50 focus:border-primary/50 transition-colors pl-9"
        />
        <McpCatalogLabelFilter />
      </div>
      {hasLabelFilters && (
        <LabelFilterBadges onRemoveLabel={handleRemoveLabel} />
      )}
      <div className="space-y-6">
        {personalItems.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Personal
            </h3>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {personalItems.map((item) => {
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
                    onReinstall={(flagged, options) =>
                      handleReinstall(item, flagged, options)
                    }
                    onEdit={() => setEditingItem(item)}
                    onDetails={() => {
                      setDetailsServerName(item.name);
                    }}
                    onDelete={() => setDeletingItem(item)}
                    onClone={() => handleClone(item)}
                    onRestartPodsStarted={handleRestartPodsStarted}
                    onRestartPodsFailed={handleRestartPodsFailed}
                    onCancelInstallation={handleCancelInstallation}
                    onAddPersonalConnection={(presetCatalogId) =>
                      handleAddPersonalConnection(item, presetCatalogId)
                    }
                    onAddSharedConnection={(teamId, presetCatalogId) =>
                      handleAddSharedConnection(item, teamId, presetCatalogId)
                    }
                    onAddOrgConnection={(presetCatalogId) =>
                      handleAddOrgConnection(item, presetCatalogId)
                    }
                    isBuiltInPlaywright={isPlaywrightCatalogItem(item.id)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {sharedItems.length > 0 ? (
          <div className="space-y-3">
            {personalItems.length > 0 && (
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Shared
              </h3>
            )}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {sharedItems.map((item) => {
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
                    onReinstall={(flagged, options) =>
                      handleReinstall(item, flagged, options)
                    }
                    onEdit={() => setEditingItem(item)}
                    onDetails={() => {
                      setDetailsServerName(item.name);
                    }}
                    onDelete={() => setDeletingItem(item)}
                    onClone={() => handleClone(item)}
                    onRestartPodsStarted={handleRestartPodsStarted}
                    onRestartPodsFailed={handleRestartPodsFailed}
                    onCancelInstallation={handleCancelInstallation}
                    onAddPersonalConnection={(presetCatalogId) =>
                      handleAddPersonalConnection(item, presetCatalogId)
                    }
                    onAddSharedConnection={(teamId, presetCatalogId) =>
                      handleAddSharedConnection(item, teamId, presetCatalogId)
                    }
                    onAddOrgConnection={(presetCatalogId) =>
                      handleAddOrgConnection(item, presetCatalogId)
                    }
                    isBuiltInPlaywright={isPlaywrightCatalogItem(item.id)}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          personalItems.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              {hasActiveFilters ? (
                <>
                  <Search className="mb-4 h-10 w-10 text-muted-foreground" />
                  <p className="text-muted-foreground">
                    No MCP servers match your filters. Try adjusting your
                    search.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4"
                    onClick={handleClearFilters}
                  >
                    Clear filters
                  </Button>
                </>
              ) : (
                <p className="text-muted-foreground">No MCP servers found.</p>
              )}
            </div>
          )
        )}
      </div>

      <CreateCatalogDialog
        isOpen={isDialogOpened("create")}
        cloneValues={cloneValues ?? undefined}
        clonedFrom={cloneSourceId ?? undefined}
        onClose={() => {
          setCloneValues(null);
          setCloneSourceId(null);
          closeDialog("create");
        }}
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
              // If the same edit also set catalogReinstallRequired (multi-tenant
              // local catalog whose execution config changed), chain the catalog
              // reinstall after the per-install one — otherwise the admin would
              // see the catalog Reinstall button reappear and have to click it
              // separately.
              const alsoReinstallCatalog =
                item.multitenant === true &&
                item.catalogReinstallRequired === true;
              handleReinstall(
                item,
                undefined,
                alsoReinstallCatalog
                  ? { alsoReinstallCatalog: true }
                  : undefined,
              );
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
      />

      <RemoteServerInstallDialog
        isOpen={isDialogOpened("remote-install")}
        onClose={() => {
          closeDialog("remote-install");
          setSelectedCatalogItem(null);
          setReauthServerId(null);
          setReinstallServerId(null);
          setReinstallServerTeamId(null);
          setReinstallServerScope(undefined);
          setPreselectedTeamId(null);
          setPreselectedCatalogId(null);
          setInstallPersonalOnly(false);
          setInstallOrgOnly(false);
        }}
        onConfirm={handleRemoteServerInstallConfirm}
        catalogItem={selectedCatalogItem}
        isInstalling={
          installMutation.isPending ||
          reauthMutation.isPending ||
          reinstallMutation.isPending
        }
        isReauth={!!reauthServerId}
        isReinstall={!!reinstallServerId && !reauthServerId}
        existingTeamId={reinstallServerTeamId}
        existingScope={reinstallServerScope}
        preselectedTeamId={preselectedTeamId}
        preselectedCatalogId={preselectedCatalogId}
        personalOnly={installPersonalOnly}
        orgOnly={installOrgOnly}
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
          setPreselectedCatalogId(null);
          setInstallPersonalOnly(false);
          setInstallOrgOnly(false);
        }}
        catalogId={selectedCatalogItem?.id}
        preselectedTeamId={preselectedTeamId}
        personalOnly={installPersonalOnly}
        orgOnly={installOrgOnly}
      />

      <ReinstallConfirmationDialog
        isOpen={isDialogOpened("reinstall")}
        onClose={() => {
          closeDialog("reinstall");
          setCatalogItemForReinstall(null);
          setReinstallFlaggedTargets([]);
        }}
        onConfirm={handleReinstallConfirm}
        serverName={catalogItemForReinstall?.name || ""}
        isReinstalling={reinstallMutation.isPending}
        targets={reinstallFlaggedTargets}
      />

      <NoAuthInstallDialog
        isOpen={isDialogOpened("no-auth")}
        onClose={() => {
          closeDialog("no-auth");
          setNoAuthCatalogItem(null);
          setPreselectedTeamId(null);
          setPreselectedCatalogId(null);
          setInstallPersonalOnly(false);
          setInstallOrgOnly(false);
        }}
        onInstall={handleNoAuthConfirm}
        catalogItem={noAuthCatalogItem}
        isInstalling={installMutation.isPending}
        preselectedTeamId={preselectedTeamId}
        preselectedCatalogId={preselectedCatalogId}
        personalOnly={installPersonalOnly}
        orgOnly={installOrgOnly}
      />

      {localServerCatalogItem && (
        <LocalServerInstallDialog
          isOpen={isDialogOpened("local-install")}
          onClose={() => {
            closeDialog("local-install");
            setLocalServerCatalogItem(null);
            setReinstallServerId(null);
            setReinstallServerTeamId(null);
            setReinstallServerScope(undefined);
            setReauthServerId(null);
            setPreselectedTeamId(null);
            setPreselectedCatalogId(null);
            setInstallPersonalOnly(false);
            setInstallOrgOnly(false);
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
          existingScope={reinstallServerScope}
          isReauth={!!reauthServerId}
          preselectedTeamId={preselectedTeamId}
          preselectedCatalogId={preselectedCatalogId}
          personalOnly={installPersonalOnly}
          orgOnly={installOrgOnly}
        />
      )}

      {manageCatalogId && (
        <ManageUsersDialog
          isOpen={isDialogOpened("manage")}
          onClose={handleManageDialogClose}
          catalogId={manageCatalogId}
          onAddPersonalConnection={(presetCatalogId) => {
            const catalogItem = catalogItems?.find(
              (item) => item.id === manageCatalogId,
            );
            if (!catalogItem) return;
            handleAddPersonalConnection(catalogItem, presetCatalogId);
          }}
          onAddSharedConnection={(teamId, presetCatalogId) => {
            const catalogItem = catalogItems?.find(
              (item) => item.id === manageCatalogId,
            );
            if (!catalogItem) return;
            handleAddSharedConnection(catalogItem, teamId, presetCatalogId);
          }}
          onAddOrgConnection={(presetCatalogId) => {
            const catalogItem = catalogItems?.find(
              (item) => item.id === manageCatalogId,
            );
            if (!catalogItem) return;
            handleAddOrgConnection(catalogItem, presetCatalogId);
          }}
        />
      )}
    </div>
  );
}

function McpCatalogLabelFilter() {
  const { data: labelKeys } = useMcpCatalogLabelKeys();
  return (
    <LabelSelect
      labelKeys={labelKeys}
      LabelKeyRowComponent={McpCatalogLabelKeyRow}
    />
  );
}

function McpCatalogLabelKeyRow({
  labelKey,
  selectedValues,
  onToggleValue,
}: {
  labelKey: string;
  selectedValues: string[];
  onToggleValue: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: values } = useMcpCatalogLabelValues({
    key: open ? labelKey : undefined,
  });
  return (
    <LabelKeyRowBase
      labelKey={labelKey}
      selectedValues={selectedValues}
      onToggleValue={onToggleValue}
      values={values}
      onOpenChange={setOpen}
    />
  );
}
