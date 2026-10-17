import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  searchMcpRegistryMock,
  getMcpServersMock,
  getIssueIndexMock,
  getCatalogItemMock,
} = vi.hoisted(() => ({
  searchMcpRegistryMock: vi.fn(),
  getMcpServersMock: vi.fn(),
  getIssueIndexMock: vi.fn(),
  getCatalogItemMock: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      searchMcpRegistry: searchMcpRegistryMock,
      getMcpServers: getMcpServersMock,
      getMcpRegistryIssueIndex: getIssueIndexMock,
      getInternalMcpCatalogItem: getCatalogItemMock,
    },
  };
});

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));

import {
  fetchInternalMcpCatalogItem,
  startMcpRegistryEarlyRequests,
  useMcpRegistryIssueIndex,
  useMcpRegistryPage,
  useMcpRegistryRowsByIds,
  useMcpServersForCatalogs,
} from "./mcp-registry.query";

describe("registry page installs", () => {
  it("come with the page, so the page's installs need no request of their own", async () => {
    const installs = [{ id: "srv-1", catalogId: "cat-b" }];
    searchMcpRegistryMock.mockResolvedValue({
      data: {
        data: [{ id: "cat-b" }, { id: "cat-a" }],
        pagination: { total: 2 },
        selectableTotal: 1,
        installs,
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => {
        const page = useMcpRegistryPage({ limit: 10, offset: 0 });
        const servers = useMcpServersForCatalogs(
          (page.data?.data ?? []).map((row) => row.id),
        );
        return { page, servers };
      },
      { wrapper },
    );

    await waitFor(() => expect(result.current.servers.data).toEqual(installs));
    expect(getMcpServersMock).not.toHaveBeenCalled();
  });
});

describe("registry page placeholder", () => {
  beforeEach(() => searchMcpRegistryMock.mockReset());

  const page = (id: string) => ({
    data: {
      data: [{ id }],
      pagination: { total: 40 },
      selectableTotal: 0,
      installs: [],
    },
  });

  function renderPage(initial: { offset: number; scope: string }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(
      ({ offset, scope }: { offset: number; scope: string }) =>
        useMcpRegistryPage({ limit: 20, offset }, { placeholderScope: scope }),
      { wrapper, initialProps: initial },
    );
  }

  it("keeps the previous page on screen while the next one loads", async () => {
    let resolveNext: (value: unknown) => void = () => {};
    searchMcpRegistryMock
      .mockResolvedValueOnce(page("cat-first"))
      .mockReturnValueOnce(new Promise((resolve) => (resolveNext = resolve)));
    const { result, rerender } = renderPage({ offset: 0, scope: "all" });
    await waitFor(() =>
      expect(result.current.data?.data[0]?.id).toBe("cat-first"),
    );

    rerender({ offset: 20, scope: "all" });

    await waitFor(() => expect(searchMcpRegistryMock).toHaveBeenCalledTimes(2));
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.data[0]?.id).toBe("cat-first");
    resolveNext(page("cat-second"));
    await waitFor(() =>
      expect(result.current.data?.data[0]?.id).toBe("cat-second"),
    );
  });

  it("drops the previous rows when the scope changes", async () => {
    searchMcpRegistryMock
      .mockResolvedValueOnce(page("cat-first"))
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderPage({ offset: 0, scope: "all" });
    await waitFor(() =>
      expect(result.current.data?.data[0]?.id).toBe("cat-first"),
    );

    rerender({ offset: 0, scope: "needs-my-action" });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe("registry early requests", () => {
  beforeEach(() => {
    searchMcpRegistryMock.mockReset();
    getIssueIndexMock.mockReset();
  });

  const body = { sortBy: "attention" as const, limit: 10, offset: 0 };
  const page = {
    data: {
      data: [{ id: "cat-a" }],
      pagination: { total: 1 },
      selectableTotal: 0,
      installs: [],
    },
  };
  const index = { data: { catalogItems: [], servers: [] } };

  function renderRegistry() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(
      () => ({
        page: useMcpRegistryPage(body, { placeholderScope: "all" }),
        index: useMcpRegistryIssueIndex(),
      }),
      { wrapper },
    );
  }

  it("hand the page and the index the requests already in flight, without sending them again", async () => {
    searchMcpRegistryMock.mockResolvedValue(page);
    getIssueIndexMock.mockResolvedValue(index);
    startMcpRegistryEarlyRequests({ page: body, index: true });
    expect(searchMcpRegistryMock).toHaveBeenCalledTimes(1);
    expect(getIssueIndexMock).toHaveBeenCalledTimes(1);

    const { result } = renderRegistry();

    await waitFor(() =>
      expect(result.current.page.data?.data[0]?.id).toBe("cat-a"),
    );
    await waitFor(() => expect(result.current.index.isSuccess).toBe(true));
    expect(searchMcpRegistryMock).toHaveBeenCalledTimes(1);
    expect(getIssueIndexMock).toHaveBeenCalledTimes(1);
  });

  it("drop a refused early request and fetch as usual", async () => {
    searchMcpRegistryMock
      .mockResolvedValueOnce({ error: { status: 401 } })
      .mockResolvedValue(page);
    getIssueIndexMock
      .mockResolvedValueOnce({ error: { status: 401 } })
      .mockResolvedValue(index);
    startMcpRegistryEarlyRequests({ page: body, index: true });

    const { result } = renderRegistry();

    await waitFor(() =>
      expect(result.current.page.data?.data[0]?.id).toBe("cat-a"),
    );
    await waitFor(() => expect(result.current.index.isSuccess).toBe(true));
    expect(searchMcpRegistryMock).toHaveBeenCalledTimes(2);
    expect(getIssueIndexMock).toHaveBeenCalledTimes(2);
  });

  it("are taken once: a later mount fetches its own", async () => {
    searchMcpRegistryMock.mockResolvedValue(page);
    getIssueIndexMock.mockResolvedValue(index);
    startMcpRegistryEarlyRequests({ page: body, index: true });
    const first = renderRegistry();
    await waitFor(() =>
      expect(first.result.current.page.data?.data[0]?.id).toBe("cat-a"),
    );

    const second = renderRegistry();

    await waitFor(() =>
      expect(second.result.current.page.data?.data[0]?.id).toBe("cat-a"),
    );
    expect(searchMcpRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("leave out the index when the document already carries it", async () => {
    searchMcpRegistryMock.mockResolvedValue(page);

    startMcpRegistryEarlyRequests({ page: body, index: false });

    expect(searchMcpRegistryMock).toHaveBeenCalledTimes(1);
    expect(getIssueIndexMock).not.toHaveBeenCalled();
  });

  it("drop an earlier load's requests when a page load starts its own", async () => {
    searchMcpRegistryMock.mockResolvedValue(page);
    getIssueIndexMock.mockResolvedValue(index);
    startMcpRegistryEarlyRequests({ page: body, index: false });
    startMcpRegistryEarlyRequests({
      page: { ...body, offset: 10 },
      index: false,
    });

    // The first load's page was never taken and is gone: mounting it fetches.
    const { result } = renderRegistry();
    await waitFor(() =>
      expect(result.current.page.data?.data[0]?.id).toBe("cat-a"),
    );
    expect(searchMcpRegistryMock).toHaveBeenCalledTimes(3);
  });
});

describe("registry rows by id", () => {
  beforeEach(() => {
    searchMcpRegistryMock.mockReset();
  });

  it("has not loaded while the first real id set is still loading", async () => {
    const pending: Array<() => void> = [];
    const release = () => {
      for (const resolve of pending.splice(0)) resolve();
    };
    searchMcpRegistryMock.mockImplementation(
      (request?: { body?: { catalogIds?: string[] } }) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({
              data: {
                data: (request?.body?.catalogIds ?? []).map((id) => ({
                  id,
                  name: id,
                })),
                pagination: { total: 1 },
                selectableTotal: 0,
                installs: [],
              },
            }),
          );
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    // A caller's ids are empty until their own source loads.
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useMcpRegistryRowsByIds(ids),
      { wrapper, initialProps: { ids: [] as string[] } },
    );
    expect(result.current.hasLoaded).toBe(false);

    rerender({ ids: ["cat-a"] });
    expect(result.current.hasLoaded).toBe(false);

    release();
    await waitFor(() => expect(result.current.hasLoaded).toBe(true));
  });

  it("keeps the rows already known while a changed id set loads", async () => {
    // Each request answers with one row per id; the second one waits.
    let releaseSecond: () => void = () => {};
    searchMcpRegistryMock.mockImplementation(
      (request?: { body?: { catalogIds?: string[] } }) => {
        const catalogIds = request?.body?.catalogIds ?? [];
        const answer = {
          data: {
            data: catalogIds.map((id) => ({ id, name: id })),
            pagination: { total: catalogIds.length },
            selectableTotal: 0,
            installs: [],
          },
        };
        if (catalogIds.length !== 2) return Promise.resolve(answer);
        return new Promise((resolve) => {
          releaseSecond = () => resolve(answer);
        });
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useMcpRegistryRowsByIds(ids),
      { wrapper, initialProps: { ids: ["cat-a"] } },
    );
    await waitFor(() => expect(result.current.hasLoaded).toBe(true));

    rerender({ ids: ["cat-a", "cat-b"] });

    // The known row stays, and the editors do not go back to loading.
    expect(result.current.data.map((row) => row.id)).toEqual(["cat-a"]);
    expect(result.current.hasLoaded).toBe(true);
    expect(result.current.isPending).toBe(true);

    releaseSecond();
    await waitFor(() =>
      expect(result.current.data.map((row) => row.id)).toEqual([
        "cat-a",
        "cat-b",
      ]),
    );
    expect(result.current.isPending).toBe(false);

    // A removed id leaves at once.
    rerender({ ids: ["cat-b"] });
    expect(result.current.data.map((row) => row.id)).toEqual(["cat-b"]);
  });
});

describe("loading a full catalog item for an action", () => {
  it("serves a second action started right after the first from the same load", async () => {
    getCatalogItemMock.mockResolvedValue({
      data: { id: "cat-a", name: "a", toolCount: 1, skillCount: 0 },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    // The Add tools list loads the item, then the Choose tools view does.
    await fetchInternalMcpCatalogItem(queryClient, "cat-a");
    const item = await fetchInternalMcpCatalogItem(queryClient, "cat-a");

    expect(item?.id).toBe("cat-a");
    expect(getCatalogItemMock).toHaveBeenCalledTimes(1);
  });
});
