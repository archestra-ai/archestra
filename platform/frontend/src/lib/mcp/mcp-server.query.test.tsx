import type { McpInstallationStatusMessage } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpInstallationStatusCacheSync } from "./mcp-server.query";

const { connectMock, subscribeMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  subscribeMock: vi.fn(),
}));

vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: connectMock,
    subscribe: subscribeMock,
  },
}));

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
