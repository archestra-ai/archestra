import type { McpInstallationStatusMessage } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useMcpInstallationStatusCacheSync,
  useMcpServers,
} from "./mcp-server.query";

const { connectMock, subscribeMock, getMcpServersMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  subscribeMock: vi.fn(),
  getMcpServersMock: vi.fn(),
}));

vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: connectMock,
    subscribe: subscribeMock,
  },
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getMcpServers: getMcpServersMock,
    },
  };
});

describe("useMcpInstallationStatusCacheSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates cached MCP server installation status from websocket messages", () => {
    let statusHandler:
      | ((message: McpInstallationStatusMessage) => void)
      | null = null;
    subscribeMock.mockImplementation((type, handler) => {
      if (type === "mcp_installation_status") {
        statusHandler = handler;
      }
      return vi.fn();
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ["mcp-servers", {}],
      [
        {
          id: "server-1",
          localInstallationStatus: "pending",
          localInstallationError: null,
        },
      ],
    );

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useMcpInstallationStatusCacheSync(), { wrapper });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith(
      "mcp_installation_status",
      expect.any(Function),
    );

    act(() => {
      statusHandler?.({
        type: "mcp_installation_status",
        payload: {
          serverId: "server-1",
          status: "error",
          error: "Install failed",
        },
      });
    });

    expect(queryClient.getQueryData(["mcp-servers", {}])).toMatchObject([
      {
        id: "server-1",
        localInstallationStatus: "error",
        localInstallationError: "Install failed",
      },
    ]);
  });
});

describe("useMcpServers permission gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMcpServersMock.mockResolvedValue({ data: [], error: undefined });
  });

  function renderMcpServers(params?: Parameters<typeof useMcpServers>[0]) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(() => useMcpServers(params), { wrapper });
  }

  it("gates the active bucket on the read permission", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as never);

    renderMcpServers();

    expect(useHasPermissions).toHaveBeenCalledWith({
      mcpServerInstallation: ["read"],
    });
    await waitFor(() => expect(getMcpServersMock).toHaveBeenCalled());
  });

  it("skips the status:'deleted' request when the delete permission is missing", () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as never);

    renderMcpServers({ status: "deleted" });

    // The deleted bucket requires mcpServerInstallation:delete on the
    // backend; without it the query must not fire (it would 403).
    expect(useHasPermissions).toHaveBeenCalledWith({
      mcpServerInstallation: ["delete"],
    });
    expect(getMcpServersMock).not.toHaveBeenCalled();
  });

  it("fetches the status:'deleted' bucket when the delete permission is granted", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as never);

    renderMcpServers({ status: "deleted" });

    await waitFor(() =>
      expect(getMcpServersMock).toHaveBeenCalledWith({
        query: { status: "deleted" },
      }),
    );
  });
});
