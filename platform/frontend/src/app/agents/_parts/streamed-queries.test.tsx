import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { memberDefaultAgentQueryKey } from "@/lib/agent.query";
import {
  agentCatalogListQuery,
  agentCatalogQueryKeys,
  useAgentCatalog,
} from "@/lib/agent-catalog.query";
import { organizationKeys } from "@/lib/organization.query";
import { PERSISTED_QUERY_META } from "@/lib/query-persistence";
import { makeAgent, makeAgentCatalog } from "@/mocks/data/agents";
import {
  STREAMED_QUERY_KEYS,
  STREAMED_QUERY_META,
} from "./stream-agent-catalog";
import { StreamedQueries } from "./streamed-queries";

const query = { limit: 10, offset: 0, pinned: false };
const queryKey = agentCatalogQueryKeys.list(agentCatalogListQuery(query));

function streamedState(promise: Promise<unknown>) {
  return {
    mutations: [],
    queries: [
      {
        queryKey,
        queryHash: JSON.stringify(queryKey),
        state: {
          data: undefined,
          dataUpdateCount: 0,
          dataUpdatedAt: 0,
          error: null,
          errorUpdateCount: 0,
          errorUpdatedAt: 0,
          fetchFailureCount: 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: "pending" as const,
          fetchStatus: "fetching" as const,
        },
        promise,
        dehydratedAt: Date.now(),
      },
    ],
  };
}

const origin = "http://localhost:9000";
const server = setupServer();
// Every catalog request the browser would make; the streamed queries need none.
let catalogRequests = 0;
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  catalogRequests = 0;
  server.use(
    http.get(`${origin}/api/agent-catalog`, () => {
      catalogRequests += 1;
      return HttpResponse.json(makeAgentCatalog());
    }),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// As the app's client: a failed request is not retried behind the user's back.
const appClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

function setup(promise: Promise<unknown>, client = appClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <StreamedQueries state={streamedState(promise)}>
        {children}
      </StreamedQueries>
    </QueryClientProvider>
  );
  return { wrapper };
}

describe("StreamedQueries", () => {
  it("renders a streamed query pending at first, even when its answer is already in, so hydration matches the server", async () => {
    const answer = makeAgentCatalog({ agents: [makeAgent({ name: "Ready" })] });
    const { wrapper } = setup(Promise.resolve(answer));

    const renders: Array<ReturnType<typeof useAgentCatalog>> = [];
    const { result } = renderHook(
      () => {
        const catalog = useAgentCatalog(query);
        renders.push(catalog);
        return catalog;
      },
      { wrapper },
    );

    expect(renders[0].data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual(answer));
    expect(catalogRequests).toBe(0);
  });

  it("keeps rows the browser already holds until the server's answer replaces them", async () => {
    const client = appClient();
    const restored = makeAgentCatalog({
      agents: [makeAgent({ name: "Restored" })],
    });
    client.setQueryData(queryKey, restored);
    let answer!: (value: unknown) => void;
    const current = makeAgentCatalog({
      agents: [makeAgent({ name: "Current" })],
    });
    const { wrapper } = setup(
      new Promise((resolve) => {
        answer = resolve;
      }),
      client,
    );

    const { result } = renderHook(() => useAgentCatalog(query), { wrapper });

    expect(result.current.data).toEqual(restored);
    expect(result.current.isFetching).toBe(true);
    answer(current);
    await waitFor(() => expect(result.current.data).toEqual(current));
    expect(catalogRequests).toBe(0);
  });

  it("does not fetch again when the page mounts after the streamed answer landed", async () => {
    const answer = makeAgentCatalog({ agents: [makeAgent({ name: "Late" })] });
    const client = appClient();
    function Catalog() {
      const { data } = useAgentCatalog(query);
      return <p>{data?.data[0]?.value.name ?? "loading"}</p>;
    }
    const tree = (mounted: boolean) => (
      <QueryClientProvider client={client}>
        <StreamedQueries state={streamedState(Promise.resolve(answer))}>
          {mounted ? <Catalog /> : null}
        </StreamedQueries>
      </QueryClientProvider>
    );
    // As on a slow device: the page's code arrives after the server's answer.
    const { rerender } = render(tree(false));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    rerender(tree(true));

    expect(await screen.findByText("Late")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(catalogRequests).toBe(0);
  });

  it("takes an answer that has already arrived as data in the first client render", () => {
    const answer = makeAgentCatalog({
      agents: [makeAgent({ name: "Arrived" })],
    });
    // As React marks an RSC promise whose row has arrived.
    const arrived = Object.assign(Promise.resolve(answer), {
      status: "fulfilled",
      value: answer,
    });
    const { wrapper } = setup(arrived);

    const renders: Array<ReturnType<typeof useAgentCatalog>> = [];
    renderHook(
      () => {
        const catalog = useAgentCatalog(query);
        renders.push(catalog);
        return catalog;
      },
      { wrapper },
    );

    expect(renders[0].data).toEqual(answer);
    expect(catalogRequests).toBe(0);
  });

  it("keeps an arrived answer pending in a server render, as the hydration render must match it", () => {
    const answer = makeAgentCatalog({
      agents: [makeAgent({ name: "Arrived" })],
    });
    const arrived = Object.assign(Promise.resolve(answer), {
      status: "fulfilled",
      value: answer,
    });
    function Catalog() {
      const { data } = useAgentCatalog(query);
      return <p>{data?.data[0]?.value.name ?? "pending"}</p>;
    }

    const html = renderToString(
      <QueryClientProvider client={appClient()}>
        <StreamedQueries state={streamedState(arrived)}>
          <Catalog />
        </StreamedQueries>
      </QueryClientProvider>,
    );

    expect(html).toContain("pending");
    expect(html).not.toContain("Arrived");
  });

  it("shows the query's error when the server's request fails", async () => {
    const { wrapper } = setup(Promise.reject(new Error("redacted")));

    const { result } = renderHook(() => useAgentCatalog(query), { wrapper });

    await waitFor(() => expect(result.current.isLoadingError).toBe(true));
  });
});

it("streams the viewer's pins and the catalog under the keys and meta the page uses", () => {
  expect(STREAMED_QUERY_KEYS.memberAgents).toEqual(memberDefaultAgentQueryKey);
  expect(STREAMED_QUERY_KEYS.organization).toEqual(organizationKeys.details());
  expect(STREAMED_QUERY_META).toEqual(PERSISTED_QUERY_META);
});
