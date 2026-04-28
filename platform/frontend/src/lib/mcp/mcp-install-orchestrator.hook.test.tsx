import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpInstallOrchestrator } from "./mcp-install-orchestrator.hook";

const {
  mutateAsyncMock,
  openDialogMock,
  redirectBrowserToUrlMock,
  setOAuthCatalogIdMock,
  setOAuthMcpServerIdMock,
  setOAuthReturnUrlMock,
  setOAuthStateMock,
  setOAuthTeamIdMock,
} = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
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
    data: [
      {
        id: "catalog-posthog",
        name: "PostHog",
        serverType: "remote",
        oauthConfig: { clientId: "client-123" },
      },
    ],
  }),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: () => ({ data: [] }),
  useInstallMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    closeDialog: vi.fn(),
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
    mutateAsyncMock.mockResolvedValue({
      authorizationUrl: "https://posthog.example.com/oauth/authorize",
      state: "oauth-state-123",
    });
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
});
