import { archestraApiSdk } from "@shared";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type { LocalServerInstallResult } from "@/app/mcp/registry/_parts/local-server-install-dialog";
import type { CatalogItem } from "@/app/mcp/registry/_parts/mcp-server-card";
import type { NoAuthInstallResult } from "@/app/mcp/registry/_parts/no-auth-install-dialog";
import type { RemoteServerInstallResult } from "@/app/mcp/registry/_parts/remote-server-install-dialog";
import type { McpServerInstallScope } from "@/app/mcp/registry/_parts/select-mcp-server-credential-type-and-teams";
import type { OAuthInstallResult } from "@/components/oauth-confirmation-dialog";
import { useInitiateOAuth } from "@/lib/auth/oauth.query";
import {
  clearPendingAfterEnvVars,
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
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useInstallMcpServer,
  useMcpServers,
  useReauthenticateMcpServer,
} from "@/lib/mcp/mcp-server.query";
import { buildRemoteInstallCredentialPayload } from "@/lib/mcp/remote-install-payload";
import { redirectBrowserToUrl } from "@/lib/utils/browser-redirect";

type DialogKey =
  | "remote-install"
  | "local-install"
  | "oauth"
  | "no-auth"
  | "manage";

type TemplateInstallPayload = {
  scope: McpServerInstallScope;
  teamId?: string | null;
  agentIds?: string[];
  userConfigValues?: Record<string, string>;
  environmentValues?: Record<string, string>;
  isByosVault?: boolean;
  serviceAccount?: string;
};

export function useMcpInstallOrchestrator() {
  const { data: catalogItems } = useInternalMcpCatalog({});
  const { data: installedServers } = useMcpServers({});
  const installMutation = useInstallMcpServer();
  const reauthMutation = useReauthenticateMcpServer();
  const initiateOAuthMutation = useInitiateOAuth();

  const { isDialogOpened, openDialog, closeDialog } = useDialogs<DialogKey>();

  const [selectedCatalogItem, setSelectedCatalogItem] =
    useState<CatalogItem | null>(null);
  const [localServerCatalogItem, setLocalServerCatalogItem] =
    useState<CatalogItem | null>(null);
  const [noAuthCatalogItem, setNoAuthCatalogItem] =
    useState<CatalogItem | null>(null);
  const localServerCatalogItemRef = useRef<CatalogItem | null>(null);
  const noAuthCatalogItemRef = useRef<CatalogItem | null>(null);

  // Manage dialog state
  const [manageCatalogId, setManageCatalogId] = useState<string | null>(null);

  // Re-authentication state
  const [reauthServerId, setReauthServerId] = useState<string | null>(null);
  const templateInstallWaitersRef = useRef<
    Map<
      string,
      {
        resolve: (value: {
          installedServerId: string | null;
          completed: boolean;
        }) => void;
        installationData: TemplateInstallPayload;
      }
    >
  >(new Map());

  const findCatalogItem = useCallback(
    (catalogId: string) => catalogItems?.find((item) => item.id === catalogId),
    [catalogItems],
  );

  const initiateOAuthRedirect = useCallback(
    async (params: {
      catalogItem: CatalogItem;
      scope?: McpServerInstallScope;
      teamId?: string | null;
      reauthServerId?: string | null;
    }) => {
      try {
        const { authorizationUrl, state } =
          await initiateOAuthMutation.mutateAsync({
            catalogId: params.catalogItem.id,
          });

        const scope: McpServerInstallScope =
          params.scope ?? (params.teamId ? "team" : "personal");

        setOAuthState(state);
        setOAuthCatalogId(params.catalogItem.id);
        setOAuthTeamId(scope === "team" ? (params.teamId ?? null) : null);
        setOAuthScope(scope);

        if (params.reauthServerId) {
          setOAuthMcpServerId(params.reauthServerId);
          setOAuthReturnUrl(window.location.href);
          setReauthServerId(null);
        } else {
          const isFirstInstallation = !installedServers?.some(
            (server) => server.catalogId === params.catalogItem.id,
          );
          setOAuthIsFirstInstallation(isFirstInstallation);
        }

        redirectBrowserToUrl(authorizationUrl);
      } catch {
        toast.error("Failed to initiate OAuth flow");
      }
    },
    [initiateOAuthMutation, installedServers],
  );

  const handleInstallRemoteServer = useCallback(
    (catalogItem: CatalogItem) => {
      const hasUserConfig =
        catalogItem.userConfig &&
        Object.keys(catalogItem.userConfig).length > 0;

      if (!hasUserConfig && catalogItem.oauthConfig) {
        setSelectedCatalogItem(catalogItem);
        openDialog("oauth");
        return;
      }

      setSelectedCatalogItem(catalogItem);
      openDialog("remote-install");
    },
    [openDialog],
  );

  const handleInstallLocalServer = useCallback(
    (catalogItem: CatalogItem) => {
      if (catalogItem.oauthConfig) {
        const promptedEnvVars =
          catalogItem.localConfig?.environment?.filter(
            (env) => env.promptOnInstallation === true,
          ) || [];

        if (promptedEnvVars.length > 0) {
          localServerCatalogItemRef.current = catalogItem;
          setLocalServerCatalogItem(catalogItem);
          setOAuthPendingAfterEnvVars(true);
          openDialog("local-install");
        } else {
          setOAuthServerType("local");
          setSelectedCatalogItem(catalogItem);
          openDialog("oauth");
        }
        return;
      }

      // No user config and no oauth → no-auth install
      const hasUserConfig =
        catalogItem.userConfig &&
        Object.keys(catalogItem.userConfig).length > 0;
      const hasPromptedEnvVars =
        catalogItem.localConfig?.environment?.some(
          (env) => env.promptOnInstallation === true,
        ) ?? false;

      if (!hasUserConfig && !hasPromptedEnvVars) {
        noAuthCatalogItemRef.current = catalogItem;
        setNoAuthCatalogItem(catalogItem);
        openDialog("no-auth");
        return;
      }

      localServerCatalogItemRef.current = catalogItem;
      setLocalServerCatalogItem(catalogItem);
      openDialog("local-install");
    },
    [openDialog],
  );

  /** Open the correct install dialog for a given catalog ID */
  const triggerInstallByCatalogId = useCallback(
    (catalogId: string) => {
      const catalogItem = findCatalogItem(catalogId);
      if (!catalogItem) return;

      if (catalogItem.serverType === "local") {
        handleInstallLocalServer(catalogItem);
      } else {
        handleInstallRemoteServer(catalogItem);
      }
    },
    [findCatalogItem, handleInstallLocalServer, handleInstallRemoteServer],
  );

  const resolveTemplateInstallWaiter = useCallback(
    (
      catalogId: string,
      value: { installedServerId: string | null; completed: boolean },
    ) => {
      const waiter = templateInstallWaitersRef.current.get(catalogId);
      if (!waiter) {
        return;
      }

      templateInstallWaitersRef.current.delete(catalogId);
      waiter.resolve(value);
    },
    [],
  );

  /** Trigger re-authentication for a specific server, preserving tool assignments */
  const triggerReauthByCatalogIdAndServerId = useCallback(
    (catalogId: string, serverId: string) => {
      const catalogItem = findCatalogItem(catalogId);
      if (!catalogItem) return;

      setReauthServerId(serverId);

      if (catalogItem.oauthConfig) {
        // OAuth server: go through OAuth flow with reauth context
        const hasUserConfig =
          catalogItem.userConfig &&
          Object.keys(catalogItem.userConfig).length > 0;

        if (!hasUserConfig) {
          void initiateOAuthRedirect({
            catalogItem,
            reauthServerId: serverId,
          });
          return;
        }

        // OAuth + user config fields: open remote install dialog in reauth mode
        setSelectedCatalogItem(catalogItem);
        openDialog("remote-install");
        return;
      }

      // Non-OAuth servers: open the appropriate dialog in reauth mode
      if (catalogItem.serverType === "local") {
        localServerCatalogItemRef.current = catalogItem;
        setLocalServerCatalogItem(catalogItem);
        openDialog("local-install");
      } else {
        setSelectedCatalogItem(catalogItem);
        openDialog("remote-install");
      }
    },
    [findCatalogItem, initiateOAuthRedirect, openDialog],
  );

  // --- Confirm handlers ---

  const handleRemoteServerInstallConfirm = useCallback(
    async (catalogItem: CatalogItem, result: RemoteServerInstallResult) => {
      const credentialPayload = buildRemoteInstallCredentialPayload(result);

      // If in reauth mode, call reauthenticate endpoint instead of install
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

      const installResult = await installMutation.mutateAsync({
        name: catalogItem.name,
        catalogId: catalogItem.id,
        ...credentialPayload,
        scope: result.scope,
        teamId:
          result.scope === "team" ? (result.teamId ?? undefined) : undefined,
      });

      resolveTemplateInstallWaiter(catalogItem.id, {
        installedServerId: installResult.installedServer?.id ?? null,
        completed: Boolean(installResult.installedServer?.id),
      });
    },
    [
      closeDialog,
      installMutation,
      reauthMutation,
      reauthServerId,
      resolveTemplateInstallWaiter,
    ],
  );

  const handleLocalServerInstallConfirm = useCallback(
    async (result: LocalServerInstallResult) => {
      const currentCatalogItem = localServerCatalogItemRef.current;
      if (!currentCatalogItem) return;

      // If in reauth mode, call reauthenticate endpoint instead of install
      if (reauthServerId) {
        await reauthMutation.mutateAsync({
          id: reauthServerId,
          name: currentCatalogItem.name,
          environmentValues: result.environmentValues,
          userConfigValues: result.userConfigValues,
          isByosVault: result.isByosVault,
        });

        closeDialog("local-install");
        localServerCatalogItemRef.current = null;
        setLocalServerCatalogItem(null);
        setReauthServerId(null);
        return;
      }

      if (getOAuthPendingAfterEnvVars() && currentCatalogItem.oauthConfig) {
        clearPendingAfterEnvVars();
        setOAuthServerType("local");
        if (
          result.environmentValues &&
          Object.keys(result.environmentValues).length > 0
        ) {
          const secretKeys = new Set(
            (currentCatalogItem.localConfig?.environment ?? [])
              .filter((e) => e.type === "secret")
              .map((e) => e.key),
          );
          const safeValues = result.isByosVault
            ? result.environmentValues
            : Object.fromEntries(
                Object.entries(result.environmentValues).filter(
                  ([key]) => !secretKeys.has(key),
                ),
              );
          if (Object.keys(safeValues).length > 0) {
            setOAuthEnvironmentValues(safeValues);
          }
        }
        if (
          result.userConfigValues &&
          Object.keys(result.userConfigValues).length > 0
        ) {
          setOAuthUserConfigValues({
            values: result.userConfigValues,
            userConfig: currentCatalogItem.userConfig,
            isByosVault: result.isByosVault,
          });
        }
        closeDialog("local-install");
        setSelectedCatalogItem(currentCatalogItem);
        localServerCatalogItemRef.current = null;
        setLocalServerCatalogItem(null);
        openDialog("oauth");
        return;
      }

      const installedServerResult = await installMutation.mutateAsync({
        name: currentCatalogItem.name,
        catalogId: currentCatalogItem.id,
        environmentValues: result.environmentValues,
        userConfigValues: result.userConfigValues,
        isByosVault: result.isByosVault,
        scope: result.scope,
        teamId:
          result.scope === "team" ? (result.teamId ?? undefined) : undefined,
        serviceAccount: result.serviceAccount,
      });

      resolveTemplateInstallWaiter(currentCatalogItem.id, {
        installedServerId: installedServerResult.installedServer?.id ?? null,
        completed: Boolean(installedServerResult.installedServer?.id),
      });

      closeDialog("local-install");
      localServerCatalogItemRef.current = null;
      setLocalServerCatalogItem(null);
    },
    [
      closeDialog,
      installMutation,
      openDialog,
      reauthMutation,
      reauthServerId,
      resolveTemplateInstallWaiter,
    ],
  );

  const handleNoAuthConfirm = useCallback(
    async (result: NoAuthInstallResult) => {
      const currentCatalogItem = noAuthCatalogItemRef.current;
      if (!currentCatalogItem) return;

      const installResult = await installMutation.mutateAsync({
        name: currentCatalogItem.name,
        catalogId: currentCatalogItem.id,
        scope: result.scope,
        teamId:
          result.scope === "team" ? (result.teamId ?? undefined) : undefined,
      });
      resolveTemplateInstallWaiter(currentCatalogItem.id, {
        installedServerId: installResult.installedServer?.id ?? null,
        completed: Boolean(installResult.installedServer?.id),
      });
      closeDialog("no-auth");
      noAuthCatalogItemRef.current = null;
      setNoAuthCatalogItem(null);
    },
    [closeDialog, installMutation, resolveTemplateInstallWaiter],
  );

  const handleOAuthConfirm = async (result: OAuthInstallResult) => {
    if (!selectedCatalogItem) return;

    await initiateOAuthRedirect({
      catalogItem: selectedCatalogItem,
      scope: result.scope,
      teamId: result.teamId,
      reauthServerId,
    });
  };

  const triggerInstallByCatalogIdAndWait = useCallback(
    async (params: {
      catalogId: string;
      installationData: TemplateInstallPayload;
    }) => {
      const catalogItem =
        findCatalogItem(params.catalogId) ??
        (await getCatalogItemById(params.catalogId));
      if (!catalogItem) {
        return { installedServerId: null, completed: false };
      }

      return new Promise<{
        installedServerId: string | null;
        completed: boolean;
      }>((resolve) => {
        templateInstallWaitersRef.current.set(params.catalogId, {
          resolve,
          installationData: params.installationData,
        });

        const resolveFailure = () => {
          resolveTemplateInstallWaiter(params.catalogId, {
            installedServerId: null,
            completed: false,
          });
        };

        if (catalogItem.serverType === "local") {
          const hasUserConfig =
            catalogItem.userConfig &&
            Object.keys(catalogItem.userConfig).length > 0;
          const hasPromptedEnvVars =
            catalogItem.localConfig?.environment?.some(
              (env) => env.promptOnInstallation === true,
            ) ?? false;

          if (
            !catalogItem.oauthConfig &&
            !hasUserConfig &&
            !hasPromptedEnvVars
          ) {
            noAuthCatalogItemRef.current = catalogItem;
            setNoAuthCatalogItem(catalogItem);
            void handleNoAuthConfirm({
              scope: params.installationData.scope,
              agentIds: params.installationData.agentIds,
              teamId:
                params.installationData.scope === "team"
                  ? (params.installationData.teamId ?? undefined)
                  : undefined,
            }).catch(resolveFailure);
            return;
          }

          localServerCatalogItemRef.current = catalogItem;
          setLocalServerCatalogItem(catalogItem);
          void handleLocalServerInstallConfirm({
            environmentValues: params.installationData.environmentValues ?? {},
            userConfigValues: params.installationData.userConfigValues,
            isByosVault: params.installationData.isByosVault,
            scope: params.installationData.scope,
            agentIds: params.installationData.agentIds,
            teamId:
              params.installationData.scope === "team"
                ? (params.installationData.teamId ?? undefined)
                : undefined,
            serviceAccount: params.installationData.serviceAccount,
          }).catch(resolveFailure);
          return;
        }

        setSelectedCatalogItem(catalogItem);
        void handleRemoteServerInstallConfirm(catalogItem, {
          metadata: Object.fromEntries(
            Object.entries(params.installationData.userConfigValues ?? {}).map(
              ([key, value]) => [key, value],
            ),
          ),
          scope: params.installationData.scope,
          agentIds: params.installationData.agentIds,
          teamId:
            params.installationData.scope === "team"
              ? (params.installationData.teamId ?? undefined)
              : undefined,
          isByosVault: params.installationData.isByosVault,
        })
          .then(() => {
            closeDialog("remote-install");
            setSelectedCatalogItem(null);
          })
          .catch(resolveFailure);
      });
    },
    [
      closeDialog,
      findCatalogItem,
      handleLocalServerInstallConfirm,
      handleNoAuthConfirm,
      handleRemoteServerInstallConfirm,
      resolveTemplateInstallWaiter,
    ],
  );

  const handleManageDialogClose = useCallback(() => {
    closeDialog("manage");
    setManageCatalogId(null);
  }, [closeDialog]);

  return {
    // Public API
    triggerInstallByCatalogId,
    triggerInstallByCatalogIdAndWait,
    triggerReauthByCatalogIdAndServerId,

    // Dialog state (for rendering)
    isDialogOpened,
    selectedCatalogItem,
    localServerCatalogItem,
    noAuthCatalogItem,
    manageCatalogId,
    isInstalling: installMutation.isPending || reauthMutation.isPending,
    isReauth: !!reauthServerId,

    // Confirm handlers
    handleRemoteServerInstallConfirm,
    handleLocalServerInstallConfirm,
    handleNoAuthConfirm,
    handleOAuthConfirm,

    // Close handlers
    handleManageDialogClose,
    closeRemoteInstall: () => {
      closeDialog("remote-install");
      setSelectedCatalogItem(null);
      setReauthServerId(null);
    },
    closeLocalInstall: () => {
      closeDialog("local-install");
      localServerCatalogItemRef.current = null;
      setLocalServerCatalogItem(null);
      setReauthServerId(null);
    },
    closeNoAuth: () => {
      closeDialog("no-auth");
      noAuthCatalogItemRef.current = null;
      setNoAuthCatalogItem(null);
    },
    closeOAuth: () => {
      closeDialog("oauth");
      setSelectedCatalogItem(null);
      setReauthServerId(null);
    },
  };
}

export type McpInstallOrchestrator = ReturnType<
  typeof useMcpInstallOrchestrator
>;

async function getCatalogItemById(
  catalogId: string,
): Promise<CatalogItem | null> {
  const response = await archestraApiSdk.getInternalMcpCatalog();
  return response.data?.find((item) => item.id === catalogId) ?? null;
}
