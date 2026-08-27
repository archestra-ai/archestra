import type {
  McpInstallationStatusMessage,
  McpServersChangedMessage,
  WebSocketReadyMessage,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useBulkUninstallMcpServers,
  useDeleteMcpServer,
  useDismissMcpServerAlerts,
  useMcpInstallationStatusCacheSync,
  useRestoreMcpServerAlerts,
} from "./mcp-server.query";

const {
  bulkDeleteMcpServersMock,
  connectMock,
  deleteMcpServerMock,
  muteCatalogAlertMock,
  muteAlertMock,
  subscribeMock,
  toastErrorMock,
  toastSuccessMock,
  unmuteAlertMock,
  unmuteCatalogAlertMock,
} = vi.hoisted(() => ({
  bulkDeleteMcpServersMock: vi.fn(),
  connectMock: vi.fn(),
  deleteMcpServerMock: vi.fn(),
  muteCatalogAlertMock: vi.fn(),
  muteAlertMock: vi.fn(),
  subscribeMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  unmuteAlertMock: vi.fn(),
  unmuteCatalogAlertMock: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      bulkDeleteMcpServers: bulkDeleteMcpServersMock,
      deleteMcpServer: deleteMcpServerMock,
      muteMcpCatalogAlert: muteCatalogAlertMock,
      muteMcpServerAlert: muteAlertMock,
      unmuteMcpCatalogAlert: unmuteCatalogAlertMock,
      unmuteMcpServerAlert: unmuteAlertMock,
    },
  };
});

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      error: toastErrorMock,
      success: toastSuccessMock,
    },
  };
});

vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: connectMock,
    subscribe: subscribeMock,
  },
}));

describe("useMcpInstallationStatusCacheSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bulkDeleteMcpServersMock.mockResolvedValue({
      data: {
        succeeded: [{ id: "server-1", name: "Removed" }],
        failed: [],
      },
    });
    deleteMcpServerMock.mockResolvedValue({ data: undefined });
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

  it("invalidates external Skills when installation discovery completes", () => {
    let statusHandler:
      | ((message: McpInstallationStatusMessage) => void)
      | null = null;
    subscribeMock.mockImplementation((type, handler) => {
      if (type === "mcp_installation_status") statusHandler = handler;
      return vi.fn();
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const externalKey = ["skills", "external-mcp", "list", null] as const;
    queryClient.setQueryData(externalKey, [{ mcpServerId: "server-1" }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useMcpInstallationStatusCacheSync(), { wrapper });

    act(() => {
      statusHandler?.({
        type: "mcp_installation_status",
        payload: { serverId: "server-1", status: "success", error: null },
      });
    });

    expect(queryClient.getQueryState(externalKey)?.isInvalidated).toBe(true);
  });

  it("evicts uninstalled MCP projections pushed from another tab", () => {
    let lifecycleHandler: ((message: McpServersChangedMessage) => void) | null =
      null;
    subscribeMock.mockImplementation((type, handler) => {
      if (type === "mcp_servers_changed") lifecycleHandler = handler;
      return vi.fn();
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const externalKey = ["skills", "external-mcp", "list", null] as const;
    const removedDetailKey = [
      "skills",
      "external-mcp",
      "detail",
      "skill-1",
      "server-1",
    ] as const;
    const retainedDetailKey = [
      "skills",
      "external-mcp",
      "detail",
      "skill-3",
      "server-3",
    ] as const;
    queryClient.setQueryData(externalKey, [
      { mcpServerId: "server-1", catalogId: "catalog-1", name: "first" },
      { mcpServerId: "server-2", catalogId: "catalog-2", name: "second" },
      { mcpServerId: "server-3", catalogId: "catalog-3", name: "retained" },
    ]);
    queryClient.setQueryData(
      ["mcp-servers", {}],
      [
        { id: "server-1", catalogId: "catalog-1" },
        { id: "server-2", catalogId: "catalog-2" },
        { id: "server-3", catalogId: "catalog-3" },
      ],
    );
    queryClient.setQueryData(removedDetailKey, {
      mcpServerId: "server-1",
      catalogId: "catalog-1",
      name: "first",
    });
    queryClient.setQueryData(retainedDetailKey, {
      mcpServerId: "server-3",
      catalogId: "catalog-3",
      name: "retained",
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useMcpInstallationStatusCacheSync(), { wrapper });

    act(() => {
      lifecycleHandler?.({
        type: "mcp_servers_changed",
        payload: {
          change: "uninstalled",
          serverIds: ["server-1"],
          catalogIds: ["catalog-2"],
        },
      });
    });

    expect(queryClient.getQueryData(externalKey)).toEqual([
      { mcpServerId: "server-3", catalogId: "catalog-3", name: "retained" },
    ]);
    expect(queryClient.getQueryData(["mcp-servers", {}])).toEqual([
      { id: "server-3", catalogId: "catalog-3" },
    ]);
    expect(queryClient.getQueryData(removedDetailKey)).toBeNull();
    expect(queryClient.getQueryData(retainedDetailKey)).toMatchObject({
      name: "retained",
    });
  });

  it("resyncs dynamic MCP caches after an authenticated reconnect", () => {
    let readyHandler: ((message: WebSocketReadyMessage) => void) | null = null;
    subscribeMock.mockImplementation((type, handler) => {
      if (type === "websocket_ready") readyHandler = handler;
      return vi.fn();
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const externalKey = ["skills", "external-mcp", "list", null] as const;
    const detailKey = [
      "skills",
      "external-mcp",
      "detail",
      "skill-1",
      "server-1",
    ] as const;
    queryClient.setQueryData(externalKey, [{ mcpServerId: "stale" }]);
    queryClient.setQueryData(detailKey, { name: "stale" });
    queryClient.setQueryData(["mcp-servers", {}], []);
    queryClient.setQueryData(["mcp-catalog"], []);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useMcpInstallationStatusCacheSync(), { wrapper });

    act(() => {
      readyHandler?.({ type: "websocket_ready", payload: {} });
    });

    expect(queryClient.getQueryState(externalKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["mcp-servers", {}])?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryState(["mcp-catalog"])?.isInvalidated).toBe(
      false,
    );

    act(() => {
      readyHandler?.({ type: "websocket_ready", payload: {} });
    });

    expect(queryClient.getQueryState(externalKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["mcp-servers", {}])?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(["mcp-catalog"])?.isInvalidated).toBe(
      true,
    );
  });

  it("removes an uninstalled server's cached Skills before refetching", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const externalKey = ["skills", "external-mcp", "list", null] as const;
    const detailKey = [
      "skills",
      "external-mcp",
      "detail",
      "skill-1",
      "server-2",
    ] as const;
    queryClient.setQueryData(externalKey, [
      { mcpServerId: "server-1", name: "stale" },
      { mcpServerId: "server-2", name: "current" },
    ]);
    queryClient.setQueryData(detailKey, { name: "current" });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDeleteMcpServer(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: "server-1", name: "Removed" });
    });

    expect(queryClient.getQueryData(externalKey)).toEqual([
      { mcpServerId: "server-2", name: "current" },
    ]);
    expect(queryClient.getQueryState(externalKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(false);
  });

  it("keeps cached Skills when an uninstall request is rejected", async () => {
    deleteMcpServerMock.mockResolvedValueOnce({
      error: { error: { message: "Denied", type: "api_error" } },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const externalKey = ["skills", "external-mcp", "list", null] as const;
    const cached = [{ mcpServerId: "server-1", name: "current" }];
    queryClient.setQueryData(externalKey, cached);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDeleteMcpServer(), { wrapper });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      result.current.mutateAsync({ id: "server-1", name: "Current" }),
    ).rejects.toThrow();

    expect(queryClient.getQueryData(externalKey)).toEqual(cached);
    consoleSpy.mockRestore();
  });

  it("removes only successfully bulk-uninstalled servers from cache", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const externalKey = ["skills", "external-mcp", "list", null] as const;
    queryClient.setQueryData(externalKey, [
      { mcpServerId: "server-1", name: "removed" },
      { mcpServerId: "server-2", name: "retained" },
    ]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useBulkUninstallMcpServers(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync([
        { id: "server-1", name: "Removed" },
        { id: "server-2", name: "Retained" },
      ]);
    });

    expect(queryClient.getQueryData(externalKey)).toEqual([
      { mcpServerId: "server-2", name: "retained" },
    ]);
  });
});

describe("MCP server alert queue mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("settles every dismissal, refreshes successful changes and reports partial success", async () => {
    muteAlertMock
      .mockRejectedValueOnce(new Error("Connection unavailable"))
      .mockResolvedValueOnce({ data: { success: true }, error: undefined });
    const queryClient = new QueryClient();
    const refetch = vi.spyOn(queryClient, "refetchQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDismissMcpServerAlerts(), {
      wrapper,
    });

    await act(async () => {
      const mutationResult = await result.current.mutateAsync({
        alerts: [
          {
            catalogId: "catalog-1",
            catalogName: "First server",
            serverId: "server-1",
            serverName: "First server",
            kind: "needs-reauth",
            issueFingerprint: "v1:needs-reauth:first",
          },
          {
            catalogId: "catalog-2",
            catalogName: "Second server",
            serverId: "server-2",
            serverName: "Second server",
            kind: "needs-reauth",
            issueFingerprint: "v1:needs-reauth:second",
          },
        ],
        reason: "Deferred",
      });
      expect(mutationResult.succeeded).toEqual([
        expect.objectContaining({ serverId: "server-2" }),
      ]);
      expect(mutationResult.failed).toEqual([
        expect.objectContaining({ serverId: "server-1" }),
      ]);
    });

    expect(toastErrorMock).toHaveBeenCalledWith("Connection unavailable");
    expect(toastSuccessMock).toHaveBeenCalledWith("Dismissed 1 of 2 alerts");
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["mcp-servers"] });
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["mcp-catalog"] });
  });

  it("omits an empty dismissal reason from the API request", async () => {
    muteAlertMock.mockResolvedValue({
      data: { success: true },
      error: undefined,
    });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDismissMcpServerAlerts(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        alerts: [
          {
            catalogId: "catalog-1",
            catalogName: "First server",
            serverId: "server-1",
            serverName: "First server",
            kind: "needs-reauth",
            issueFingerprint: "v1:needs-reauth:first",
          },
        ],
      });
    });

    expect(muteAlertMock).toHaveBeenCalledWith({
      path: { id: "server-1", kind: "needs-reauth" },
      body: { issueFingerprint: "v1:needs-reauth:first" },
    });
  });

  it("reports the connection that actually restored after a partial result", async () => {
    unmuteAlertMock
      .mockRejectedValueOnce(new Error("Connection unavailable"))
      .mockResolvedValueOnce({ data: { success: true }, error: undefined });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRestoreMcpServerAlerts(), {
      wrapper,
    });

    await act(async () => {
      const mutationResult = await result.current.mutateAsync({
        alerts: [
          {
            catalogId: "catalog-1",
            catalogName: "First server",
            serverId: "server-1",
            serverName: "First server",
            kind: "needs-reauth",
            issueFingerprint: "v1:needs-reauth:first",
          },
          {
            catalogId: "catalog-2",
            catalogName: "Second server",
            serverId: "server-2",
            serverName: "Second server",
            kind: "needs-reauth",
            issueFingerprint: "v1:needs-reauth:second",
          },
        ],
      });
      expect(mutationResult.succeeded).toEqual([
        expect.objectContaining({ serverId: "server-2" }),
      ]);
      expect(mutationResult.failed).toEqual([
        expect.objectContaining({ serverId: "server-1" }),
      ]);
    });

    expect(toastSuccessMock).toHaveBeenCalledWith("Restored 1 of 2 alerts");
  });

  it("routes catalog-level alerts through the catalog dismissal API", async () => {
    muteCatalogAlertMock.mockResolvedValue({
      data: { success: true },
      error: undefined,
    });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDismissMcpServerAlerts(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        alerts: [
          {
            catalogId: "catalog-1",
            catalogName: "Shared server",
            serverId: null,
            kind: "failed-to-start",
            issueFingerprint: "v1:failed-to-start:test",
          },
        ],
        reason: "Deferred",
      });
    });

    expect(muteCatalogAlertMock).toHaveBeenCalledWith({
      path: { id: "catalog-1", kind: "failed-to-start" },
      body: {
        issueFingerprint: "v1:failed-to-start:test",
        reason: "Deferred",
      },
    });
    expect(muteAlertMock).not.toHaveBeenCalled();
  });
});
