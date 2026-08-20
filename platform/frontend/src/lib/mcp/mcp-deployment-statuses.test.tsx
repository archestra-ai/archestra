import type { McpDeploymentStatusesMessage } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  getMcpServersMock,
  isConnectedMock,
  onConnectionChangeMock,
  sendMock,
  subscribeMock,
  useFeatureMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  getMcpServersMock: vi.fn(),
  isConnectedMock: vi.fn(),
  onConnectionChangeMock: vi.fn(),
  sendMock: vi.fn(),
  subscribeMock: vi.fn(),
  useFeatureMock: vi.fn(),
}));

// Only the server-list test needs the mcp-servers query to run; the others
// deny the permission it is gated on so no fetch happens behind them.
let canReadInstallations = false;
// Only the session test signs anyone in; without a user the feed has no
// per-user state to reset.
let sessionUserId: string | null = null;

vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: connectMock,
    isConnected: isConnectedMock,
    onConnectionChange: onConnectionChangeMock,
    send: sendMock,
    subscribe: subscribeMock,
  },
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: useFeatureMock,
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: canReadInstallations }),
  useSession: () => ({
    data: sessionUserId ? { user: { id: sessionUserId } } : null,
  }),
}));

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

const SUBSCRIBE_MESSAGE = {
  type: "subscribe_mcp_deployment_statuses",
  payload: {},
};
const UNSUBSCRIBE_MESSAGE = {
  type: "unsubscribe_mcp_deployment_statuses",
  payload: {},
};

const RUNNING_STATUS = {
  state: "running" as const,
  message: "Running",
  error: null,
};

// React Query notifies its observers on a zero-delay timer, which fake timers
// hold back until it is explicitly advanced.
async function flushQueryNotifications() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useMcpDeploymentStatuses", () => {
  let queryClient: QueryClient;
  let socketUnsubscribe: ReturnType<typeof vi.fn>;
  let connectionUnsubscribe: ReturnType<typeof vi.fn>;
  let pushStatuses: ((message: McpDeploymentStatusesMessage) => void) | null;
  let notifyConnectionChange: ((isConnected: boolean) => void) | null;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  // Each test needs the module-level feed to start cold, so the hook is
  // re-imported after resetting the registry rather than imported at the top.
  const renderFeed = async () => {
    const { useMcpDeploymentStatuses } = await import("./mcp-server.query");
    return renderHook(() => useMcpDeploymentStatuses(), { wrapper });
  };

  // The feed reads the installed-server list out of the query cache, so a test
  // that exercises that path has to mount the query some other page owns.
  const renderFeedWithServerList = async () => {
    const { useMcpDeploymentStatuses, useMcpServers } = await import(
      "./mcp-server.query"
    );
    return renderHook(
      () => {
        useMcpServers();
        return useMcpDeploymentStatuses();
      },
      { wrapper },
    );
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();

    canReadInstallations = false;
    sessionUserId = null;

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    socketUnsubscribe = vi.fn();
    connectionUnsubscribe = vi.fn();
    pushStatuses = null;
    notifyConnectionChange = null;
    subscribeMock.mockImplementation((type, handler) => {
      if (type === "mcp_deployment_statuses") {
        pushStatuses = handler;
      }
      return socketUnsubscribe;
    });
    onConnectionChangeMock.mockImplementation((handler) => {
      notifyConnectionChange = handler;
      return connectionUnsubscribe;
    });
    isConnectedMock.mockReturnValue(true);
    useFeatureMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the feed alive when one of several consumers unmounts", async () => {
    const first = await renderFeed();
    const second = await renderFeed();

    // One socket subscription is shared by both consumers.
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(SUBSCRIBE_MESSAGE);

    first.unmount();

    expect(sendMock).not.toHaveBeenCalledWith(UNSUBSCRIBE_MESSAGE);
    expect(socketUnsubscribe).not.toHaveBeenCalled();

    act(() => {
      pushStatuses?.({
        type: "mcp_deployment_statuses",
        payload: { statuses: { "server-1": RUNNING_STATUS } },
      });
    });

    expect(second.result.current).toEqual({
      statuses: { "server-1": RUNNING_STATUS },
      state: "ready",
    });

    second.unmount();

    expect(sendMock).toHaveBeenCalledWith(UNSUBSCRIBE_MESSAGE);
    expect(socketUnsubscribe).toHaveBeenCalledTimes(1);
    expect(connectionUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribes once when the socket is still connecting on a cold load", async () => {
    // The shared socket is opened one tick before the feed mounts, so it is
    // CONNECTING here — the state every page load starts in.
    isConnectedMock.mockReturnValue(false);

    const { result } = await renderFeed();

    // Nothing to subscribe to yet, and the socket's own replay queue must not
    // be handed a subscribe the open handler is about to send anyway.
    expect(sendMock).not.toHaveBeenCalled();
    expect(result.current.state).toBe("loading");

    isConnectedMock.mockReturnValue(true);
    act(() => {
      notifyConnectionChange?.(true);
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(SUBSCRIBE_MESSAGE);
  });

  it("reports disconnected, not loading, when the first attempt fails", async () => {
    isConnectedMock.mockReturnValue(false);

    const { result } = await renderFeed();
    expect(result.current.state).toBe("loading");

    // The backend never accepted the socket: there is no first payload to wait
    // for, so the feed must stop claiming it is still loading.
    act(() => {
      notifyConnectionChange?.(false);
    });

    expect(result.current).toEqual({ statuses: {}, state: "disconnected" });
  });

  it("re-subscribes on every reconnect, not on a sampled edge", async () => {
    const { result } = await renderFeed();

    act(() => {
      pushStatuses?.({
        type: "mcp_deployment_statuses",
        payload: { statuses: { "server-1": RUNNING_STATUS } },
      });
    });
    expect(result.current.state).toBe("ready");

    isConnectedMock.mockReturnValue(false);
    act(() => {
      notifyConnectionChange?.(false);
    });
    expect(result.current.state).toBe("disconnected");
    // The last known statuses stay on screen while the socket is down.
    expect(result.current.statuses).toEqual({ "server-1": RUNNING_STATUS });

    sendMock.mockClear();
    isConnectedMock.mockReturnValue(true);
    act(() => {
      notifyConnectionChange?.(true);
    });

    // The backend forgot the subscription with the closed socket.
    expect(sendMock).toHaveBeenCalledWith(SUBSCRIBE_MESSAGE);
    expect(result.current.state).toBe("ready");

    // A close and reopen too fast for any poll to sample still costs the
    // server-side subscription, so it still has to be re-sent.
    sendMock.mockClear();
    act(() => {
      isConnectedMock.mockReturnValue(false);
      notifyConnectionChange?.(false);
      isConnectedMock.mockReturnValue(true);
      notifyConnectionChange?.(true);
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(SUBSCRIBE_MESSAGE);
  });

  it("re-subscribes when the installed server list changes", async () => {
    canReadInstallations = true;
    getMcpServersMock.mockResolvedValue({ data: [{ id: "server-1" }] });

    await renderFeedWithServerList();
    await flushQueryNotifications();
    sendMock.mockClear();

    getMcpServersMock.mockResolvedValue({
      data: [{ id: "server-1" }, { id: "server-2" }],
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
    });
    await flushQueryNotifications();

    // The backend resolved the accessible-server list at subscribe time, so
    // server-2 is invisible to the feed until it is asked for again.
    expect(sendMock).toHaveBeenCalledWith(SUBSCRIBE_MESSAGE);
  });

  it("reports disabled, never loading, when the K8s runtime feature is off", async () => {
    useFeatureMock.mockReturnValue(false);

    const { result } = await renderFeed();

    expect(result.current).toEqual({ statuses: {}, state: "disabled" });
    expect(subscribeMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("waits, rather than reporting disabled, while the feature flag is unresolved", async () => {
    // `useFeature` reports undefined until the config query resolves; settling
    // on "disabled" there would answer for every deployment on first render.
    useFeatureMock.mockReturnValue(undefined);

    const { result } = await renderFeed();

    expect(result.current).toEqual({ statuses: {}, state: "loading" });
    expect(subscribeMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("drops the previous user's statuses when the session user changes", async () => {
    sessionUserId = "user-1";
    const { result, rerender } = await renderFeed();

    act(() => {
      pushStatuses?.({
        type: "mcp_deployment_statuses",
        payload: { statuses: { "server-1": RUNNING_STATUS } },
      });
    });
    expect(result.current.statuses).toEqual({ "server-1": RUNNING_STATUS });

    sendMock.mockClear();
    sessionUserId = "user-2";
    act(() => {
      rerender();
    });

    // Pod names and runtime errors belong to the servers the previous user
    // could see; the next user starts from nothing and asks for their own.
    expect(result.current.statuses).toEqual({});
    expect(sendMock).toHaveBeenCalledWith(SUBSCRIBE_MESSAGE);
  });
});
