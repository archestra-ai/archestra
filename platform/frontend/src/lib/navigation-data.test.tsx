import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useProfilesPaginated } from "@/lib/agent.query";
import {
  agentCatalogQueryKeys,
  useAgentCatalog,
} from "@/lib/agent-catalog.query";
import { prefetchApps, useApps } from "@/lib/app.query";
import { authQueryKeys } from "@/lib/auth/auth.query";
import {
  makeAgent,
  makeAgentCatalog,
  makeAgentsList,
} from "@/mocks/data/agents";

const origin = "http://localhost:9000";
const server = setupServer();
const clients: QueryClient[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => archestraApiClient.setConfig({ baseUrl: origin }));
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  clients.push(client);
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

describe("navigation data reuse", () => {
  it("renders the server's default agent list without a second fetch", () => {
    const { wrapper } = setup();
    const seed = makeAgentsList({
      agents: [makeAgent({ name: "Visible agent" })],
    });
    const { result } = renderHook(
      () =>
        useProfilesPaginated({
          offset: 0,
          limit: DEFAULT_TABLE_LIMIT,
          agentTypes: ["agent"],
          excludeOtherPersonalAgents: true,
          initialData: seed,
          initialDataExcludeOtherPersonalAgents: true,
        }),
      { wrapper },
    );

    expect(result.current.isPending).toBe(false);
    expect(result.current.isFetching).toBe(false);
    expect(result.current.data?.data[0].name).toBe("Visible agent");
  });

  it.each([
    { excludeOtherPersonalAgents: undefined },
    { offset: DEFAULT_TABLE_LIMIT },
    { name: "different" },
    { scope: "personal" as const },
  ])("does not seed a different agent view: %j", async (overrides) => {
    const { wrapper } = setup();
    server.use(
      http.get(`${origin}/api/agents`, () =>
        HttpResponse.json(
          makeAgentsList({ agents: [makeAgent({ name: "Requested view" })] }),
        ),
      ),
    );
    const { result } = renderHook(
      () =>
        useProfilesPaginated({
          offset: 0,
          limit: DEFAULT_TABLE_LIMIT,
          agentTypes: ["agent"],
          excludeOtherPersonalAgents: true,
          initialData: makeAgentsList({
            agents: [makeAgent({ name: "Wrong seed" })],
          }),
          initialDataExcludeOtherPersonalAgents: true,
          ...overrides,
        }),
      { wrapper },
    );

    expect(result.current.data).toBeUndefined();
    await waitFor(() =>
      expect(result.current.data?.data[0].name).toBe("Requested view"),
    );
  });

  it("shares the intent-prefetched Apps page with the mounted query", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(authQueryKeys.session(), { user: { id: "user-1" } });
    client.setQueryData(authQueryKeys.userPermissions(), { app: ["read"] });
    const requests: string[] = [];
    server.use(
      http.get(`${origin}/api/apps`, ({ request }) => {
        requests.push(new URL(request.url).search);
        return HttpResponse.json({
          data: [{ id: "app-1", name: "Prefetched app" }],
          pagination: { total: 1 },
        });
      }),
    );

    await Promise.all([prefetchApps(client), prefetchApps(client)]);
    const { result } = renderHook(
      () =>
        useApps({
          limit: 100,
          offset: 0,
          search: undefined,
          scope: undefined,
          authorIds: undefined,
          excludeAuthorIds: undefined,
          labels: undefined,
        }),
      { wrapper },
    );
    expect(result.current.isPending).toBe(false);
    expect(result.current.data?.data[0].name).toBe("Prefetched app");
    expect(requests).toEqual(["?limit=100&offset=0"]);

    const filtered = renderHook(
      () => useApps({ limit: 100, offset: 0, search: "other" }),
      { wrapper },
    );
    expect(filtered.result.current.data).toBeUndefined();
    await waitFor(() => expect(requests).toHaveLength(2));
  });

  it("does not prefetch without both a session and permission", async () => {
    const { client } = setup();
    client.setQueryData(authQueryKeys.userPermissions(), { app: ["read"] });
    await prefetchApps(client);
    client.setQueryData(authQueryKeys.session(), { user: { id: "user-1" } });
    client.setQueryData(authQueryKeys.userPermissions(), {});
    await prefetchApps(client);
    expect(client.getQueryCache().findAll({ queryKey: ["apps"] })).toHaveLength(
      0,
    );
  });

  it("does not report an Apps request cancelled during navigation", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(authQueryKeys.session(), { user: { id: "user-1" } });
    client.setQueryData(authQueryKeys.userPermissions(), { app: ["read"] });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markAborted: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    server.use(
      http.get(`${origin}/api/apps`, async ({ request }) => {
        markStarted?.();
        request.signal.addEventListener("abort", () => markAborted?.(), {
          once: true,
        });
        await new Promise(() => {});
        return HttpResponse.json({ data: [], pagination: { total: 0 } });
      }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const query = renderHook(() => useApps({ limit: 100, offset: 0 }), {
      wrapper,
    });
    await started;
    query.unmount();
    await aborted;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("agent catalog freshness", () => {
  it.each([
    false,
    true,
  ])("paints a restored catalog, then refreshes it when mounted (pinned=%s)", async (pinned) => {
    const { client, wrapper } = setup();
    const query = {
      offset: 0,
      limit: DEFAULT_TABLE_LIMIT,
      excludeOtherPersonalAgents: true,
      pinned,
    };
    const oldAgent = makeAgent({ id: "old-agent", name: "Old agent" });
    const newAgent = makeAgent({ id: "new-agent", name: "New agent" });
    const previous = makeAgentCatalog({ agents: [oldAgent] });
    const current = makeAgentCatalog({ agents: [newAgent] });
    // A recently restored cache is still fresh under the app's one-minute
    // stale time, but must not hide a creation or retain a deleted agent.
    // Restored data keeps the time it was fetched, before this page mounted.
    client.setQueryData(
      agentCatalogQueryKeys.list({ includeTools: false, ...query }),
      previous,
      { updatedAt: Date.now() - 30_000 },
    );
    let requests = 0;
    server.use(
      http.get(`${origin}/api/agent-catalog`, () => {
        requests += 1;
        return HttpResponse.json(current);
      }),
    );

    const { result } = renderHook(() => useAgentCatalog(query), { wrapper });

    expect(result.current.data).toEqual(previous);
    await waitFor(() => expect(result.current.data).toEqual(current));
    expect(requests).toBe(1);
  });

  it("refreshes a catalog stamped in the same millisecond as the mount", async () => {
    const { client, wrapper } = setup();
    const query = {
      offset: 0,
      limit: DEFAULT_TABLE_LIMIT,
      excludeOtherPersonalAgents: true,
      pinned: false,
    };
    const previous = makeAgentCatalog({
      agents: [makeAgent({ id: "old-agent", name: "Old agent" })],
    });
    const current = makeAgentCatalog({
      agents: [makeAgent({ id: "new-agent", name: "New agent" })],
    });
    let requests = 0;
    server.use(
      http.get(`${origin}/api/agent-catalog`, () => {
        requests += 1;
        return HttpResponse.json(current);
      }),
    );

    // The cache write and the mount read the same clock value, as they can
    // when both happen within one millisecond.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    client.setQueryData(
      agentCatalogQueryKeys.list({ includeTools: false, ...query }),
      previous,
    );
    const { result } = renderHook(() => useAgentCatalog(query), { wrapper });
    clock.mockRestore();

    expect(result.current.data).toEqual(previous);
    await waitFor(() => expect(result.current.data).toEqual(current));
    expect(requests).toBe(1);
  });
});
