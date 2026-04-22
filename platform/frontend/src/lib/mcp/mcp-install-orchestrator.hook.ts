import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { LocalServerInstallResult } from "@/app/mcp/registry/_parts/local-server-install-dialog";
import type { CatalogItem } from "@/app/mcp/registry/_parts/mcp-server-card";
import type { NoAuthInstallResult } from "@/app/mcp/registry/_parts/no-auth-install-dialog";
import type { RemoteServerInstallResult } from "@/app/mcp/registry/_parts/remote-server-install-dialog";
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

  // Manage dialog state
  const [manageCatalogId, setManageCatalogId] = useState<string | null>(null);

  // Re-authentication state
  const [reauthServerId, setReauthServerId] = useState<string | null>(null);

  const findCatalogItem = useCallback(
    (catalogId: string) => catalogItems?.find((item) => item.id === catalogId),
    [catalogItems],
  );

  const initiateOAuthRedirect = useCallback(
    async (params: {
      catalogItem: CatalogItem;
      teamId?: string | null;
      reauthServerId?: string | null;
    }) => {
      try {
        const { authorizationUrl, state } =
          await initiateOAuthMutation.mutateAsync({
            catalogId: params.catalogItem.id,
          });

        setOAuthState(state);
        setOAuthCatalogId(params.catalogItem.id);
        setOAuthTeamId(params.teamId ?? null);

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
        setNoAuthCatalogItem(catalogItem);
        openDialog("no-auth");
        return;
      }

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

  const handleRemoteServerInstallConfirm = async (
    catalogItem: CatalogItem,
    result: RemoteServerInstallResult,
  ) => {
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

    await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: catalogItem.id,
      ...credentialPayload,
      teamId: result.teamId ?? undefined,
    });
  };

  const handleLocalServerInstallConfirm = async (
    installResult: LocalServerInstallResult,
  ) => {
    if (!localServerCatalogItem) return;

    // If in reauth mode, call reauthenticate endpoint instead of install
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

    if (getOAuthPendingAfterEnvVars() && localServerCatalogItem.oauthConfig) {
      clearPendingAfterEnvVars();
      setOAuthServerType("local");
      if (
        installResult.environmentValues &&
        Object.keys(installResult.environmentValues).length > 0
      ) {
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
      setSelectedCatalogItem(localServerCatalogItem);
      setLocalServerCatalogItem(null);
      openDialog("oauth");
      return;
    }

    await installMutation.mutateAsync({
      name: localServerCatalogItem.name,
      catalogId: localServerCatalogItem.id,
      environmentValues: installResult.environmentValues,
      userConfigValues: installResult.userConfigValues,
      isByosVault: installResult.isByosVault,
      teamId: installResult.teamId ?? undefined,
      serviceAccount: installResult.serviceAccount,
    });

    closeDialog("local-install");
    setLocalServerCatalogItem(null);
  };

  const handleNoAuthConfirm = async (result: NoAuthInstallResult) => {
    if (!noAuthCatalogItem) return;

    await installMutation.mutateAsync({
      name: noAuthCatalogItem.name,
      catalogId: noAuthCatalogItem.id,
      teamId: result.teamId ?? undefined,
    });
    closeDialog("no-auth");
    setNoAuthCatalogItem(null);
  };

  const handleOAuthConfirm = async (result: OAuthInstallResult) => {
    if (!selectedCatalogItem) return;

    await initiateOAuthRedirect({
      catalogItem: selectedCatalogItem,
      teamId: result.teamId,
      reauthServerId,
    });
  };

  const handleManageDialogClose = useCallback(() => {
    closeDialog("manage");
    setManageCatalogId(null);
  }, [closeDialog]);

  return {
    // Public API
    triggerInstallByCatalogId,
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
      setLocalServerCatalogItem(null);
      setReauthServerId(null);
    },
    closeNoAuth: () => {
      closeDialog("no-auth");
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
