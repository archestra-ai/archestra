import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePinApp } from "@/lib/app.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getApps: vi.fn(),
    getApp: vi.fn(),
    getExternalApp: vi.fn(),
    getAppVersions: vi.fn(),
    getAppTools: vi.fn(),
    createApp: vi.fn(),
    updateApp: vi.fn(),
    deleteApp: vi.fn(),
    assignToolToApp: vi.fn(),
    unassignToolFromApp: vi.fn(),
    openAppInChat: vi.fn(),
    openExternalAppInChat: vi.fn(),
    pinApp: vi.fn(),
    unpinApp: vi.fn(),
    pinExternalApp: vi.fn(),
    unpinExternalApp: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The two apps-list cache entries that coexist in the real app: the sidebar's
// unsearched list and the Apps page's list while a search is active. A
// pin/unpin must update both, or the two surfaces drift apart until a refresh.
const plainKey = ["apps", "paginated", { limit: 100, offset: 0 }];
const searchedKey = [
  "apps",
  "paginated",
  { limit: 100, offset: 0, search: "jira" },
];

const ownedApp = (pinnedAt: string | null) => ({
  source: "owned",
  id: "app-1",
  name: "Owned App",
  pinnedAt,
});
const externalApp = (
  pinnedAt: string | null,
  toolName = "create_ticket",
  resourceUri = "ui://widget",
) => ({
  source: "external",
  mcpServerId: "server-1",
  resourceUri,
  toolName,
  name: `Server / ${toolName}`,
  pinnedAt,
});

function listResponse(data: unknown[]) {
  return { data, pagination: { total: data.length } };
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(() => usePinApp(), { wrapper });
  return { queryClient, result };
}

const pinnedOf = (queryClient: QueryClient, key: unknown[]) =>
  (
    queryClient.getQueryData(key as never) as {
      data: Array<{ pinnedAt: string | null }>;
    }
  ).data.map((app) => app.pinnedAt);

describe("usePinApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("optimistically unpins the app in every cached list before the request resolves", async () => {
    // Hold the DELETE open so the assertion below observes the optimistic
    // write, not the post-invalidation refetch.
    let release: (value: { error: undefined }) => void = () => {};
    vi.mocked(archestraApiSdk.unpinApp).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );

    const { queryClient, result } = setup();
    queryClient.setQueryData(plainKey, listResponse([ownedApp("2026-01-01")]));
    queryClient.setQueryData(
      searchedKey,
      listResponse([ownedApp("2026-01-01")]),
    );

    result.current.mutate({
      pinned: false,
      target: { source: "owned", appId: "app-1" },
    });

    await waitFor(() => {
      expect(pinnedOf(queryClient, plainKey)).toEqual([null]);
      expect(pinnedOf(queryClient, searchedKey)).toEqual([null]);
    });

    release({ error: undefined });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("pins exactly one external tool tile, even when other tools share its ui resource", async () => {
    vi.mocked(archestraApiSdk.pinExternalApp).mockResolvedValue({
      error: undefined,
    } as never);

    const { queryClient, result } = setup();
    // Three tools of one server, two of them sharing "ui://widget" — the shape
    // that previously made one pin fan out across the whole group.
    queryClient.setQueryData(
      plainKey,
      listResponse([
        externalApp(null, "create_ticket"),
        externalApp(null, "edit_ticket"),
        externalApp(null, "search_tickets", "ui://other-widget"),
        ownedApp(null),
      ]),
    );

    result.current.mutate({
      pinned: true,
      target: {
        source: "external",
        mcpServerId: "server-1",
        resourceUri: "ui://widget",
        toolName: "create_ticket",
      },
    });

    await waitFor(() => {
      const pins = pinnedOf(queryClient, plainKey);
      expect(pins[0]).not.toBeNull();
      expect(pins[1]).toBeNull();
      expect(pins[2]).toBeNull();
      expect(pins[3]).toBeNull();
    });
    expect(vi.mocked(archestraApiSdk.pinExternalApp)).toHaveBeenCalledWith({
      path: { mcpServerId: "server-1" },
      body: { resourceUri: "ui://widget", toolName: "create_ticket" },
    });
  });

  it("rolls the optimistic flip back when the request fails", async () => {
    vi.mocked(archestraApiSdk.unpinApp).mockResolvedValue({
      error: { error: { message: "boom", type: "internal_server_error" } },
    } as never);

    const { queryClient, result } = setup();
    queryClient.setQueryData(plainKey, listResponse([ownedApp("2026-01-01")]));

    result.current.mutate({
      pinned: false,
      target: { source: "owned", appId: "app-1" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(pinnedOf(queryClient, plainKey)).toEqual(["2026-01-01"]);
  });
});
