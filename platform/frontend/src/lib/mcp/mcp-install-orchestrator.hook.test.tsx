import { archestraApiSdk } from "@shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpInstallOrchestrator } from "./mcp-install-orchestrator.hook";

const {
  catalogItemsMock,
  mutateAsyncMock,
  installMutateAsyncMock,
  closeDialogMock,
  openDialogMock,
  redirectBrowserToUrlMock,
  setOAuthCatalogIdMock,
  setOAuthMcpServerIdMock,
  setOAuthReturnUrlMock,
  setOAuthStateMock,
  setOAuthTeamIdMock,
} = vi.hoisted(() => ({
  catalogItemsMock: [
    {
      id: "catalog-posthog",
      name: "PostHog",
      serverType: "remote",
      oauthConfig: { clientId: "client-123" },
    },
  ] as Array<Record<string, unknown>>,
  mutateAsyncMock: vi.fn(),
  installMutateAsyncMock: vi.fn(),
  closeDialogMock: vi.fn(),
  openDialogMock: vi.fn(),
  redirectBrowserToUrlMock: vi.fn(),
  setOAuthCatalogIdMock: vi.fn(),
  setOAuthMcpServerIdMock: vi.fn(),
  setOAuthReturnUrlMock: vi.fn(),
  setOAuthStateMock: vi.fn(),
  setOAuthTeamIdMock: vi.fn(),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: () => ({
    data: catalogItemsMock,
  }),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: () => ({ data: [] }),
  useInstallMcpServer: () => ({
    mutateAsync: installMutateAsyncMock,
    isPending: false,
  }),
  useReauthenticateMcpServer: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/oauth.query", () => ({
  useInitiateOAuth: () => ({
    mutateAsync: mutateAsyncMock,
  }),
}));

vi.mock("@/lib/hooks/use-dialog", () => ({
  useDialogs: () => ({
    isDialogOpened: () => false,
    openDialog: openDialogMock,
    closeDialog: closeDialogMock,
  }),
}));

vi.mock("@/lib/utils/browser-redirect", () => ({
  redirectBrowserToUrl: redirectBrowserToUrlMock,
}));

vi.mock("@/lib/auth/oauth-session", () => ({
  clearPendingAfterEnvVars: vi.fn(),
  getOAuthPendingAfterEnvVars: vi.fn(() => false),
  setOAuthCatalogId: setOAuthCatalogIdMock,
  setOAuthEnvironmentValues: vi.fn(),
  setOAuthIsFirstInstallation: vi.fn(),
  setOAuthMcpServerId: setOAuthMcpServerIdMock,
  setOAuthPendingAfterEnvVars: vi.fn(),
  setOAuthReturnUrl: setOAuthReturnUrlMock,
  setOAuthScope: vi.fn(),
  setOAuthServerType: vi.fn(),
  setOAuthState: setOAuthStateMock,
  setOAuthTeamId: setOAuthTeamIdMock,
  setOAuthUserConfigValues: vi.fn(),
}));

describe("useMcpInstallOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogItemsMock.splice(0, catalogItemsMock.length, {
      id: "catalog-posthog",
      name: "PostHog",
      serverType: "remote",
      oauthConfig: { clientId: "client-123" },
    });
    installMutateAsyncMock.mockResolvedValue({
      installedServer: { id: "server-installed-1" },
    });
    mutateAsyncMock.mockResolvedValue({
      authorizationUrl: "https://posthog.example.com/oauth/authorize",
      state: "oauth-state-123",
    });
    vi.spyOn(archestraApiSdk, "getInternalMcpCatalog").mockResolvedValue({
      data: [...catalogItemsMock] as never,
      error: undefined,
    } as unknown as Awaited<
      ReturnType<typeof archestraApiSdk.getInternalMcpCatalog>
    >);
  });

  it("starts OAuth immediately for pure OAuth re-authentication", async () => {
    const { result } = renderHook(() => useMcpInstallOrchestrator());

    act(() => {
      result.current.triggerReauthByCatalogIdAndServerId(
        "catalog-posthog",
        "server-123",
      );
    });

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        catalogId: "catalog-posthog",
      });
    });

    expect(openDialogMock).not.toHaveBeenCalled();
    expect(setOAuthStateMock).toHaveBeenCalledWith("oauth-state-123");
    expect(setOAuthCatalogIdMock).toHaveBeenCalledWith("catalog-posthog");
    expect(setOAuthTeamIdMock).toHaveBeenCalledWith(null);
    expect(setOAuthMcpServerIdMock).toHaveBeenCalledWith("server-123");
    expect(setOAuthReturnUrlMock).toHaveBeenCalledWith(window.location.href);
    expect(redirectBrowserToUrlMock).toHaveBeenCalledWith(
      "https://posthog.example.com/oauth/authorize",
    );
  });

  it("returns installed server id by reusing the existing manual remote confirm flow", async () => {
    catalogItemsMock.splice(0, catalogItemsMock.length, {
      id: "catalog-remote-manual",
      name: "Remote Manual",
      serverType: "remote",
      oauthConfig: null,
      userConfig: {
        apiKey: {
          type: "string",
          title: "API key",
          description: "Credential",
          required: true,
        },
      },
    });
    const { result } = renderHook(() => useMcpInstallOrchestrator());

    await expect(
      result.current.triggerInstallByCatalogIdAndWait({
        catalogId: "catalog-remote-manual",
        installationData: {
          userConfigValues: { access_token: "token-1" },
          scope: "personal",
          isByosVault: false,
        },
      }),
    ).resolves.toEqual({
      installedServerId: "server-installed-1",
      completed: true,
    });

    expect(installMutateAsyncMock).toHaveBeenCalledWith({
      name: "Remote Manual",
      catalogId: "catalog-remote-manual",
      accessToken: "token-1",
      isByosVault: false,
      scope: "personal",
      teamId: undefined,
    });
    expect(closeDialogMock).toHaveBeenCalledWith("remote-install");
    expect(result.current.selectedCatalogItem).toBeNull();
  });

  it("reuses the existing local confirm flow before resolving", async () => {
    catalogItemsMock.splice(0, catalogItemsMock.length, {
      id: "catalog-local-manual",
      name: "Local Manual",
      serverType: "local",
      oauthConfig: null,
      userConfig: {
        apiKey: {
          type: "string",
          title: "API key",
          description: "Credential",
          required: true,
        },
      },
      localConfig: {
        environment: [
          {
            key: "API_BASE_URL",
            type: "plain_text",
            promptOnInstallation: true,
            description: "Base URL",
          },
        ],
      },
    });
    const { result } = renderHook(() => useMcpInstallOrchestrator());

    await expect(
      result.current.triggerInstallByCatalogIdAndWait({
        catalogId: "catalog-local-manual",
        installationData: {
          environmentValues: { API_BASE_URL: "https://example.test" },
          userConfigValues: { apiKey: "token-1" },
          scope: "personal",
          serviceAccount: "svc-account",
        },
      }),
    ).resolves.toEqual({
      installedServerId: "server-installed-1",
      completed: true,
    });

    expect(installMutateAsyncMock).toHaveBeenCalledWith({
      name: "Local Manual",
      catalogId: "catalog-local-manual",
      environmentValues: { API_BASE_URL: "https://example.test" },
      userConfigValues: { apiKey: "token-1" },
      isByosVault: undefined,
      scope: "personal",
      teamId: undefined,
      serviceAccount: "svc-account",
    });
    expect(closeDialogMock).toHaveBeenCalledWith("local-install");
    expect(result.current.localServerCatalogItem).toBeNull();
  });

  it("reuses the existing no-auth confirm flow before resolving", async () => {
    catalogItemsMock.splice(0, catalogItemsMock.length, {
      id: "catalog-local-no-auth",
      name: "Local No Auth",
      serverType: "local",
      oauthConfig: null,
      userConfig: null,
      localConfig: {
        environment: [],
      },
    });
    const { result } = renderHook(() => useMcpInstallOrchestrator());

    await expect(
      result.current.triggerInstallByCatalogIdAndWait({
        catalogId: "catalog-local-no-auth",
        installationData: {
          scope: "personal",
        },
      }),
    ).resolves.toEqual({
      installedServerId: "server-installed-1",
      completed: true,
    });

    expect(installMutateAsyncMock).toHaveBeenCalledWith({
      name: "Local No Auth",
      catalogId: "catalog-local-no-auth",
      scope: "personal",
      teamId: undefined,
    });
    expect(closeDialogMock).toHaveBeenCalledWith("no-auth");
    expect(result.current.noAuthCatalogItem).toBeNull();
  });

  it("does not finalize early when catalog data is cold", async () => {
    catalogItemsMock.splice(0, catalogItemsMock.length);
    const { result } = renderHook(() => useMcpInstallOrchestrator());

    await expect(
      result.current.triggerInstallByCatalogIdAndWait({
        catalogId: "catalog-posthog",
        installationData: {
          userConfigValues: { apiKey: "token-1" },
          scope: "personal",
        },
      }),
    ).resolves.toEqual({
      installedServerId: "server-installed-1",
      completed: true,
    });
  });

  it("returns incomplete when the reused install flow fails", async () => {
    catalogItemsMock.splice(0, catalogItemsMock.length, {
      id: "catalog-remote-manual",
      name: "Remote Manual",
      serverType: "remote",
      oauthConfig: null,
      userConfig: {
        apiKey: {
          type: "string",
          title: "API key",
          description: "Credential",
          required: true,
        },
      },
    });
    installMutateAsyncMock.mockRejectedValueOnce(new Error("install failed"));
    const { result } = renderHook(() => useMcpInstallOrchestrator());

    const pending = result.current.triggerInstallByCatalogIdAndWait({
      catalogId: "catalog-remote-manual",
      installationData: {
        userConfigValues: { apiKey: "token-1" },
        scope: "personal",
      },
    });

    await expect(pending).resolves.toEqual({
      installedServerId: null,
      completed: false,
    });
  });

  it("opens the install dialog without finalizing when a manual install is requested", () => {
    const { result } = renderHook(() => useMcpInstallOrchestrator());

    act(() => {
      result.current.triggerInstallByCatalogId("catalog-posthog");
    });

    expect(openDialogMock).toHaveBeenCalledWith("oauth");
    expect(installMutateAsyncMock).not.toHaveBeenCalled();
  });
});
