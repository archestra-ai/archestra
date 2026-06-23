"use client";

import {
  MCP_CATALOG_INSTALL_QUERY_PARAM,
  MCP_CATALOG_INSTALL_SCOPE_QUERY_PARAM,
  MCP_CATALOG_INSTALL_TEAM_QUERY_PARAM,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  OAuthConfirmationDialog,
  type OAuthInstallResult,
} from "@/components/oauth-confirmation-dialog";
import { useInitiateOAuth } from "@/lib/auth/oauth.query";
import {
  clearInstallationCompleteCatalogId,
  clearPendingAfterEnvVars,
  getOAuthInstallationCompleteCatalogId,
  getOAuthPendingAfterEnvVars,
  setOAuthCatalogId,
  setOAuthEnvironmentValues,
  setOAuthIsFirstInstallation,
  setOAuthPendingAfterEnvVars,
  setOAuthScope,
  setOAuthServerType,
  setOAuthState,
  setOAuthTeamId,
  setOAuthUserConfigValues,
} from "@/lib/auth/oauth-session";
import { useDialogs } from "@/lib/hooks/use-dialog";
import {
  clearPendingEnterpriseManagedInstall,
  type EnterpriseManagedInstallIntent,
  getPendingEnterpriseManagedInstall,
  setPendingEnterpriseManagedInstall,
  useEnterpriseManagedInstallConnectUrl,
} from "@/lib/mcp/enterprise-managed-install-auth";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useInstallMcpServer, useMcpServers } from "@/lib/mcp/mcp-server.query";
import { buildRemoteInstallCredentialPayload } from "@/lib/mcp/remote-install-payload";
import websocketService from "@/lib/websocket/websocket";
import {
  LocalServerInstallDialog,
  type LocalServerInstallResult,
} from "../../_parts/local-server-install-dialog";
import {
  NoAuthInstallDialog,
  type NoAuthInstallResult,
} from "../../_parts/no-auth-install-dialog";
import {
  RemoteServerInstallDialog,
  type RemoteServerInstallResult,
} from "../../_parts/remote-server-install-dialog";
import type { McpServerInstallScope } from "../../_parts/select-mcp-server-credential-type-and-teams";
import type { CatalogItem } from "./mcp-server-card";

export interface UseCatalogInstallResult {
  /** Add a personal connection (skips dialog when no config is needed). */
  addPersonalConnection: (item: CatalogItem) => void;
  /** Add a team-shared connection (skips dialog when no config is needed). */
  addSharedConnection: (item: CatalogItem, teamId: string) => void;
  /** Add an organization-wide connection (skips dialog when no config). */
  addOrgConnection: (item: CatalogItem) => void;
  /** Open the remote (or OAuth) install flow for an item. */
  installRemote: (item: CatalogItem) => void;
  /** Open the local install flow for an item. */
  installLocal: (item: CatalogItem) => void;
  /** Install the built-in Playwright server directly (no dialog). */
  installPlaywright: (item: CatalogItem) => void;
  /** Consume the ?install=/&scope=/&team= deep-link params, if present. */
  installFromSearchParams: () => void;
  /** Catalog id of the item whose install is currently being submitted. */
  installingItemId: string | null;
  /** Installed server ids currently being polled for completion. */
  installingServerIds: Set<string>;
  /** Mutate the install polling set (used by reinstall/reauth flows). */
  setInstallingServerIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Mutate the "currently submitting" catalog id (reinstall/reauth flows). */
  setInstallingItemId: React.Dispatch<React.SetStateAction<string | null>>;
  /** Stop polling a server (passed to the card's cancel action). */
  cancelInstallation: (serverId: string) => void;
  /** Install-mode dialogs (remote, OAuth, no-auth, local). */
  dialogs: ReactNode;
}

/**
 * Owns the catalog INSTALL flow (install / add-personal / add-shared /
 * add-org, remote / local / no-auth, OAuth, enterprise managed-install guard,
 * the install mutation, query invalidations, success toasts, and the
 * install-mode dialogs).
 *
 * The logic here is moved verbatim from InternalMCPCatalog so OAuth,
 * sessionStorage, and secret-filtering behavior are preserved exactly.
 * Reinstall and reauthentication intentionally live outside this hook — they
 * reuse the polling set / installingItemId exposed from the return value.
 */
export function useCatalogInstall(opts?: {
  onInstalled?: () => void;
}): UseCatalogInstallResult {
  const onInstalled = opts?.onInstalled;

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const { data: catalogItems } = useInternalMcpCatalog({});
  const { data: installedServers } = useMcpServers();
  const installMutation = useInstallMcpServer();
  const initiateOAuthMutation = useInitiateOAuth();
  const queryClient = useQueryClient();

  const { isDialogOpened, openDialog, closeDialog } = useDialogs<
    "remote-install" | "local-install" | "oauth" | "no-auth"
  >();

  const [installingItemId, setInstallingItemId] = useState<string | null>(null);
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

  // Pre-selected team ID when adding a shared connection from manage dialog
  const [preselectedTeamId, setPreselectedTeamId] = useState<string | null>(
    null,
  );
  // When true, install dialog hides the team selector (personal connection only)
  const [installPersonalOnly, setInstallPersonalOnly] = useState(false);
  // When true, install dialog forces the organization-wide scope
  const [installOrgOnly, setInstallOrgOnly] = useState(false);

  const [selectedCatalogItem, setSelectedCatalogItem] =
    useState<CatalogItem | null>(null);
  const [noAuthCatalogItem, setNoAuthCatalogItem] =
    useState<CatalogItem | null>(null);
  const [localServerCatalogItem, setLocalServerCatalogItem] =
    useState<CatalogItem | null>(null);

  const getEnterpriseManagedInstallConnectUrl =
    useEnterpriseManagedInstallConnectUrl();

  const ensureEnterpriseManagedInstallAuth = useCallback(
    async (
      catalogItem: CatalogItem,
      intent: EnterpriseManagedInstallIntent,
    ): Promise<boolean> => {
      const connectUrl = await getEnterpriseManagedInstallConnectUrl({
        catalogItem,
        redirectTo: "/mcp/registry/beta",
      });
      if (!connectUrl) {
        return true;
      }

      setPendingEnterpriseManagedInstall(intent);
      window.location.assign(connectUrl);
      return false;
    },
    [getEnterpriseManagedInstallConnectUrl],
  );

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

  // Clear OAuth installation completion state
  useEffect(() => {
    const oauthCatalogId = getOAuthInstallationCompleteCatalogId();
    if (oauthCatalogId) {
      clearInstallationCompleteCatalogId();
    }
  }, []);

  const installRemote = async (
    catalogItem: CatalogItem,
    options?: {
      preserveInstallTarget?: boolean;
      scope?: McpServerInstallScope;
      teamId?: string;
    },
  ) => {
    if (!options?.preserveInstallTarget) {
      setPreselectedTeamId(null);
      setInstallPersonalOnly(false);
      setInstallOrgOnly(false);
    }

    const scope = options?.scope
      ? options.scope
      : installOrgOnly
        ? "org"
        : preselectedTeamId
          ? "team"
          : installPersonalOnly
            ? "personal"
            : undefined;
    const teamId = options?.teamId ?? preselectedTeamId ?? undefined;
    if (
      !(await ensureEnterpriseManagedInstallAuth(catalogItem, {
        action: "open-remote",
        catalogId: catalogItem.id,
        scope,
        ...(teamId ? { teamId } : {}),
      }))
    ) {
      return;
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

  const installLocal = async (
    catalogItem: CatalogItem,
    options?: {
      preserveInstallTarget?: boolean;
      scope?: McpServerInstallScope;
      teamId?: string;
    },
  ) => {
    if (!options?.preserveInstallTarget) {
      setPreselectedTeamId(null);
      setInstallPersonalOnly(false);
      setInstallOrgOnly(false);
    }

    const scope = options?.scope
      ? options.scope
      : installOrgOnly
        ? "org"
        : preselectedTeamId
          ? "team"
          : installPersonalOnly
            ? "personal"
            : undefined;
    const teamId = options?.teamId ?? preselectedTeamId ?? undefined;
    if (
      !(await ensureEnterpriseManagedInstallAuth(catalogItem, {
        action: "open-local",
        catalogId: catalogItem.id,
        scope,
        ...(teamId ? { teamId } : {}),
      }))
    ) {
      return;
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
    },
  ) => {
    const scope: McpServerInstallScope =
      target?.scope ?? (target?.teamId ? "team" : "personal");
    if (
      !(await ensureEnterpriseManagedInstallAuth(catalogItem, {
        action: "direct",
        catalogId: catalogItem.id,
        scope,
        ...(scope === "team" && target?.teamId
          ? { teamId: target.teamId }
          : {}),
      }))
    ) {
      return;
    }

    setInstallingItemId(catalogItem.id);
    const result = await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: catalogItem.id,
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
    onInstalled?.();
  };

  // Add personal connection: skip dialog if no config needed, otherwise open dialog with personalOnly
  const addPersonalConnection = (catalogItem: CatalogItem) => {
    if (canDirectInstall(catalogItem)) {
      handleDirectInstall(catalogItem);
    } else {
      setInstallPersonalOnly(true);
      if (catalogItem.serverType === "local") {
        installLocal(catalogItem, {
          preserveInstallTarget: true,
          scope: "personal",
        });
      } else {
        installRemote(catalogItem, {
          preserveInstallTarget: true,
          scope: "personal",
        });
      }
    }
  };

  // Add shared connection: skip dialog if no config needed, otherwise open dialog with preselected team
  const addSharedConnection = (catalogItem: CatalogItem, teamId: string) => {
    if (canDirectInstall(catalogItem)) {
      handleDirectInstall(catalogItem, {
        teamId,
        scope: "team",
      });
    } else {
      setPreselectedTeamId(teamId);
      if (catalogItem.serverType === "local") {
        installLocal(catalogItem, {
          preserveInstallTarget: true,
          scope: "team",
          teamId,
        });
      } else {
        installRemote(catalogItem, {
          preserveInstallTarget: true,
          scope: "team",
          teamId,
        });
      }
    }
  };

  // Add organization connection: skip dialog if no config needed, otherwise
  // open dialog with scope locked to org.
  const addOrgConnection = (catalogItem: CatalogItem) => {
    if (canDirectInstall(catalogItem)) {
      handleDirectInstall(catalogItem, { scope: "org" });
    } else {
      setInstallOrgOnly(true);
      if (catalogItem.serverType === "local") {
        installLocal(catalogItem, {
          preserveInstallTarget: true,
          scope: "org",
        });
      } else {
        installRemote(catalogItem, {
          preserveInstallTarget: true,
          scope: "org",
        });
      }
    }
  };

  // Deep-link: auto-open install dialog when ?install={catalogId} is present.
  // Optional &scope=personal|team|org (and &team={teamId} for team scope)
  // pre-target the connection — used by the item detail page's add-connection
  // actions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run on searchParams/catalogItems; install handlers are stable within a render
  const installFromSearchParams = useCallback(() => {
    const installCatalogId = searchParams.get(MCP_CATALOG_INSTALL_QUERY_PARAM);
    if (!installCatalogId || !catalogItems) return;

    const catalogItem = catalogItems.find(
      (item) => item.id === installCatalogId,
    );
    if (!catalogItem) return;

    const scopeParam = searchParams.get(MCP_CATALOG_INSTALL_SCOPE_QUERY_PARAM);
    const teamParam = searchParams.get(MCP_CATALOG_INSTALL_TEAM_QUERY_PARAM);

    // Clear the install params from URL to prevent re-triggering on refresh
    const params = new URLSearchParams(searchParams.toString());
    params.delete(MCP_CATALOG_INSTALL_QUERY_PARAM);
    params.delete(MCP_CATALOG_INSTALL_SCOPE_QUERY_PARAM);
    params.delete(MCP_CATALOG_INSTALL_TEAM_QUERY_PARAM);
    const newUrl = params.toString()
      ? `${pathname}?${params.toString()}`
      : pathname;
    router.replace(newUrl, { scroll: false });

    if (scopeParam === "personal") {
      addPersonalConnection(catalogItem);
      return;
    }
    if (scopeParam === "team" && teamParam) {
      addSharedConnection(catalogItem, teamParam);
      return;
    }
    if (scopeParam === "org") {
      addOrgConnection(catalogItem);
      return;
    }

    // Trigger the appropriate install dialog
    if (catalogItem.serverType === "local") {
      installLocal(catalogItem);
    } else {
      installRemote(catalogItem);
    }
  }, [searchParams, catalogItems, pathname, router]);

  // Resume an enterprise-managed install after linking the configured IdP.
  // biome-ignore lint/correctness/useExhaustiveDependencies: consume the one-shot sessionStorage intent when catalog data becomes available
  useEffect(() => {
    if (!catalogItems) return;

    const intent = getPendingEnterpriseManagedInstall();
    if (!intent) return;

    const catalogItem = catalogItems.find(
      (item) => item.id === intent.catalogId,
    );
    if (!catalogItem) return;

    clearPendingEnterpriseManagedInstall();

    setPreselectedTeamId(
      intent.scope === "team" ? (intent.teamId ?? null) : null,
    );
    setInstallPersonalOnly(intent.scope === "personal");
    setInstallOrgOnly(intent.scope === "org");

    switch (intent.action) {
      case "direct":
        void handleDirectInstall(catalogItem, {
          scope: intent.scope,
          teamId: intent.teamId,
        });
        return;
      case "open-local":
        void installLocal(catalogItem, {
          preserveInstallTarget: true,
          scope: intent.scope,
          teamId: intent.teamId,
        });
        return;
      case "open-remote":
        void installRemote(catalogItem, {
          preserveInstallTarget: true,
          scope: intent.scope,
          teamId: intent.teamId,
        });
        return;
    }
  }, [catalogItems]);

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
    onInstalled?.();
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
    onInstalled?.();
  };

  const handleRemoteServerInstallConfirm = async (
    catalogItem: CatalogItem,
    result: RemoteServerInstallResult,
  ) => {
    const credentialPayload = buildRemoteInstallCredentialPayload(result);

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
    onInstalled?.();
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

      // Store if this is a first installation (for auto-opening assignments dialog)
      const isFirstInstallation = !installedServers?.some(
        (s) => s.catalogId === selectedCatalogItem.id,
      );
      setOAuthIsFirstInstallation(isFirstInstallation);

      // Redirect to OAuth provider
      window.location.href = authorizationUrl;
    } catch {
      toast.error("Failed to initiate OAuth flow");
    }
  };

  const cancelInstallation = (serverId: string) => {
    // Remove server from installing set to stop polling
    setInstallingServerIds((prev) => {
      const newSet = new Set(prev);
      newSet.delete(serverId);
      return newSet;
    });
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
    onInstalled?.();
  };

  const dialogs = (
    <>
      <RemoteServerInstallDialog
        isOpen={isDialogOpened("remote-install")}
        onClose={() => {
          closeDialog("remote-install");
          setSelectedCatalogItem(null);
          setPreselectedTeamId(null);
          setInstallPersonalOnly(false);
          setInstallOrgOnly(false);
        }}
        onConfirm={handleRemoteServerInstallConfirm}
        catalogItem={selectedCatalogItem}
        isInstalling={installMutation.isPending}
        preselectedTeamId={preselectedTeamId}
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
          setPreselectedTeamId(null);
          setInstallPersonalOnly(false);
          setInstallOrgOnly(false);
        }}
        catalogId={selectedCatalogItem?.id}
        preselectedTeamId={preselectedTeamId}
        personalOnly={installPersonalOnly}
        orgOnly={installOrgOnly}
      />

      <NoAuthInstallDialog
        isOpen={isDialogOpened("no-auth")}
        onClose={() => {
          closeDialog("no-auth");
          setNoAuthCatalogItem(null);
          setPreselectedTeamId(null);
          setInstallPersonalOnly(false);
          setInstallOrgOnly(false);
        }}
        onInstall={handleNoAuthConfirm}
        catalogItem={noAuthCatalogItem}
        isInstalling={installMutation.isPending}
        preselectedTeamId={preselectedTeamId}
        personalOnly={installPersonalOnly}
        orgOnly={installOrgOnly}
      />

      {localServerCatalogItem && (
        <LocalServerInstallDialog
          isOpen={isDialogOpened("local-install")}
          onClose={() => {
            closeDialog("local-install");
            setLocalServerCatalogItem(null);
            setPreselectedTeamId(null);
            setInstallPersonalOnly(false);
            setInstallOrgOnly(false);
          }}
          onConfirm={handleLocalServerInstallConfirm}
          catalogItem={localServerCatalogItem}
          isInstalling={installMutation.isPending}
          preselectedTeamId={preselectedTeamId}
          personalOnly={installPersonalOnly}
          orgOnly={installOrgOnly}
        />
      )}
    </>
  );

  return {
    addPersonalConnection,
    addSharedConnection,
    addOrgConnection,
    installRemote: (item) => void installRemote(item),
    installLocal: (item) => void installLocal(item),
    installPlaywright: (item) => void handleInstallPlaywright(item),
    installFromSearchParams,
    installingItemId,
    installingServerIds,
    setInstallingServerIds,
    setInstallingItemId,
    cancelInstallation,
    dialogs,
  };
}
