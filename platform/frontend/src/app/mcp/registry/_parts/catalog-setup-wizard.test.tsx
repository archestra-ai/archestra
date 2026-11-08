import type { McpDeploymentStatusEntry } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import {
  useMcpDeploymentStatuses,
  useMcpServers,
} from "@/lib/mcp/mcp-server.query";
import websocketService from "@/lib/websocket/websocket";
import { TestConnectionStep } from "./catalog-setup-wizard";
import type { CatalogItem } from "./mcp-server-card";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/auth/oauth.query", () => ({
  useInitiateOAuth: () => ({ mutateAsync: vi.fn() }),
}));
// The install dialogs stay closed in these tests; their own data hooks are
// not what is under test.
vi.mock("./remote-server-install-dialog", () => ({
  RemoteServerInstallDialog: () => null,
}));
vi.mock("./local-server-install-dialog", () => ({
  LocalServerInstallDialog: () => null,
}));
vi.mock("@/components/oauth-confirmation-dialog", () => ({
  OAuthConfirmationDialog: () => null,
}));
vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useInstallMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMcpDeploymentStatuses: vi.fn(),
  useMcpInstallationStatusCacheSync: vi.fn(),
  useMcpServers: vi.fn(),
  useReloadMcpServerTools: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The websocket is the process boundary for pod logs: record subscriptions so
// a test can push the server's log lines through it.
const wsHandlers = vi.hoisted(
  () => new Map<string, Set<(message: unknown) => void>>(),
);
vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: vi.fn(),
    isConnected: () => true,
    send: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
    subscribe: vi.fn((type: string, handler: (message: unknown) => void) => {
      const handlers = wsHandlers.get(type) ?? new Set();
      handlers.add(handler);
      wsHandlers.set(type, handlers);
      return () => handlers.delete(handler);
    }),
  },
}));

const CRASH_LOOP: McpDeploymentStatusEntry = {
  state: "failed",
  message: "CrashLoopBackOff",
  error: "Back-off restarting failed container",
  restartCount: 4,
  podName: "mcp-orbit-7f9c6d-x2k4p",
};

beforeEach(() => {
  wsHandlers.clear();
  vi.mocked(websocketService.send).mockClear();
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
});

describe("TestConnectionStep failure", () => {
  it("shows a local server's pod logs inline instead of linking away", async () => {
    renderFailedStep({ serverType: "local", status: CRASH_LOOP });

    expect(screen.getByText("Connection failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pod is in CrashLoopBackOff after 4 restarts. Its logs are below.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /view logs/i }),
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(websocketService.send).toHaveBeenCalledWith({
        type: "subscribe_mcp_logs",
        payload: expect.objectContaining({ serverId: "install-1" }),
      }),
    );
    act(() => {
      for (const handler of wsHandlers.get("mcp_logs") ?? []) {
        handler({
          type: "mcp_logs",
          payload: {
            serverId: "install-1",
            logs: "AuthenticationError: ORBIT_TOKEN is required\n",
          },
        });
      }
    });
    expect(
      await screen.findByText("AuthenticationError: ORBIT_TOKEN is required"),
    ).toBeInTheDocument();
  });

  it("keeps a remote server's failure to the error, with no log stream", () => {
    renderFailedStep({ serverType: "remote", status: undefined });

    expect(screen.getByText("Connection failed")).toBeInTheDocument();
    expect(
      screen.getByText("Check the server URL and credentials, then retry."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(websocketService.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "subscribe_mcp_logs" }),
    );
  });
});

function renderFailedStep({
  serverType,
  status,
}: {
  serverType: "local" | "remote";
  status: McpDeploymentStatusEntry | undefined;
}) {
  vi.mocked(useMcpServers).mockReturnValue({
    data: [
      {
        id: "install-1",
        name: "Orbit",
        catalogId: "catalog-1",
        ownerId: "user-1",
        teamId: null,
        createdAt: "2026-11-06T13:48:00.000Z",
        localInstallationStatus: "error",
        localInstallationError:
          "Failed to connect to MCP server Orbit: MCP error -32000: Connection closed",
      },
    ],
  } as unknown as ReturnType<typeof useMcpServers>);
  vi.mocked(useMcpDeploymentStatuses).mockReturnValue({
    statuses: status ? { "install-1": status } : {},
  } as unknown as ReturnType<typeof useMcpDeploymentStatuses>);

  const item = {
    id: "catalog-1",
    name: "Orbit",
    serverType,
    localConfig: null,
    userConfig: null,
    oauthConfig: null,
  } as unknown as CatalogItem;

  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TestConnectionStep item={item} />
    </QueryClientProvider>,
  );
}
