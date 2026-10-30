import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authQueryKeys,
  useAllPermissions,
  useHasPagePermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  clearPersistedQueryCache,
  DEFAULT_STALE_TIME,
  restorePersistedQueryCache,
  syncPersistedQueryCacheScope,
} from "@/lib/query-persistence";

// A reader whose only way onto a page is a grant on one object: no org-wide
// MCP gateway read, a read grant on one gateway.

vi.mock("@/lib/clients/auth/auth-client");
vi.mock("@archestra/shared", async () => {
  const actual = await vi.importActual("@archestra/shared");
  return {
    ...actual,
    archestraApiSdk: {
      getUserPermissions: vi.fn(),
      getScopedCapabilities: vi.fn(),
    },
  };
});

const grant = {
  organizationId: "org-1",
  resource: "mcpGateway",
  action: "read",
  scope: "gateway-1",
};

beforeEach(() => {
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: { user: { id: "member-1" }, session: { id: "session-1" } },
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
    data: { chat: ["read"] },
  } as never);
  vi.mocked(archestraApiSdk.getScopedCapabilities).mockResolvedValue({
    data: [grant],
  } as never);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  clearPersistedQueryCache();
  window.sessionStorage.clear();
});

describe("scoped capabilities", () => {
  it("opens a guarded page straight after a refresh, before the grants are re-read", async () => {
    const before = makeClient();
    const loaded = renderHook(
      () => ({
        session: useSession(),
        permissions: useAllPermissions(),
        capabilities: useScopedCapabilities(),
      }),
      { wrapper: wrap(before) },
    );
    await waitFor(() =>
      expect(loaded.result.current.capabilities.isSuccess).toBe(true),
    );
    syncPersistedQueryCacheScope(before, "member-1:org-1");
    loaded.unmount();

    // The reload: a new cache restored from the snapshot, and a grants
    // request that has not answered yet.
    vi.mocked(archestraApiSdk.getScopedCapabilities).mockReturnValue(
      new Promise(() => undefined) as never,
    );
    const after = makeClient();
    restorePersistedQueryCache(after);
    const { result } = renderHook(
      () => useHasPagePermissions({ mcpGateway: ["read"] }),
      { wrapper: wrap(after) },
    );

    expect(result.current).toEqual({ data: true, isPending: false });
  });

  it("reuses the grants on a page mounted more than a minute later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = makeClient();
    const first = renderHook(() => useScopedCapabilities(), {
      wrapper: wrap(client),
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    vi.setSystemTime(Date.now() + 70_000);
    const second = renderHook(() => useScopedCapabilities(), {
      wrapper: wrap(client),
    });

    expect(second.result.current.data).toEqual([grant]);
    expect(archestraApiSdk.getScopedCapabilities).toHaveBeenCalledTimes(1);
  });

  it("re-reads the grants when a role, member or team change refreshes auth", async () => {
    const client = makeClient();
    const { result } = renderHook(
      () => {
        const { data, isSuccess } = useScopedCapabilities();
        return { data, isSuccess };
      },
      { wrapper: wrap(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    vi.mocked(archestraApiSdk.getScopedCapabilities).mockResolvedValue({
      data: [],
    } as never);

    // What the role, member and team mutations invalidate.
    await client.invalidateQueries({ queryKey: authQueryKeys.all });

    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(archestraApiSdk.getScopedCapabilities).toHaveBeenCalledTimes(2);
  });
});

function makeClient() {
  // The app's own defaults: a one-minute freshness and no retries.
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: DEFAULT_STALE_TIME },
    },
  });
}

function wrap(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
