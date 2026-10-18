import { archestraApiClient, E2eTestId } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  agentCatalogListQuery,
  agentCatalogQueryKeys,
} from "@/lib/agent-catalog.keys";
import { makeAgent, makeAgentCatalog } from "@/mocks/data/agents";
import { sessionSeed } from "@/mocks/data/auth";
import { organizationSeed } from "@/mocks/data/organization";
import { handlers } from "@/mocks/handlers";
import {
  agentListQuery,
  DEFAULT_CATALOG_FILTERS,
  pinnedAgentsQuery,
} from "./catalog-queries";
import AgentsPage from "./page.client";
import { streamAgentCatalog } from "./stream-agent-catalog";
import { StreamedQueries } from "./streamed-queries";

vi.mock("next/navigation");
vi.mock("sonner");

const origin = window.location.origin;
const server = setupServer(...handlers);
const clients: QueryClient[] = [];

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "bypass" });
});
beforeEach(() => {
  server.resetHandlers();
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/agents");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});
afterAll(() => server.close());

function renderPage(
  memberAgents?: {
    defaultAgentId: string | null;
    personalChatAgentId: string | null;
  },
  wrap: (page: React.ReactNode) => React.ReactNode = (page) => page,
  seed?: (client: QueryClient) => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  clients.push(client);
  client.setQueryData(["auth", "session"], sessionSeed);
  client.setQueryData(["organization", "details"], organizationSeed);
  if (memberAgents) client.setQueryData(["member-default-agent"], memberAgents);
  seed?.(client);
  render(
    <QueryClientProvider client={client}>
      {wrap(<AgentsPage />)}
    </QueryClientProvider>,
  );
}

it("loads the pinned agents and the list on the client, without an empty state while the list is out", async () => {
  let releaseList!: () => void;
  const listHeld = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const requests: string[] = [];
  server.use(
    http.get(`${origin}/api/agent-catalog`, async ({ request }) => {
      const pinned = new URL(request.url).searchParams.get("pinned");
      requests.push(`pinned=${pinned}`);
      if (pinned === "true") {
        return HttpResponse.json(
          makeAgentCatalog({
            agents: [makeAgent({ id: "pinned-1", name: "Pinned helper" })],
          }),
        );
      }
      await listHeld;
      return HttpResponse.json(
        makeAgentCatalog({
          agents: [makeAgent({ id: "listed-1", name: "Listed agent" })],
        }),
      );
    }),
  );
  renderPage({ defaultAgentId: null, personalChatAgentId: null });

  expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
  expect(await screen.findByText("Pinned helper")).toBeInTheDocument();
  const table = screen.getByTestId(E2eTestId.AgentsTable);
  // The list's section stays in place as placeholder rows, rather than empty.
  const loadingTable = within(table).getByRole("table");
  expect(loadingTable).toHaveAttribute("aria-busy", "true");
  expect(within(loadingTable).getAllByRole("row")).toHaveLength(1 + 10);
  expect(screen.queryByText("No agents found")).not.toBeInTheDocument();

  releaseList();

  expect(await screen.findByText("Listed agent")).toBeInTheDocument();
  expect(requests.sort()).toEqual(["pinned=false", "pinned=true"]);
});

it("requests the list once, leaving out the viewer's automatic pins that load after it mounts", async () => {
  const listRequests: URLSearchParams[] = [];
  server.use(
    http.get(`${origin}/api/members/default-agent`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return HttpResponse.json({
        defaultAgentId: null,
        personalChatAgentId: "personal-1",
      });
    }),
    http.get(`${origin}/api/agent-catalog`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (params.get("pinned") !== "false") {
        return HttpResponse.json(makeAgentCatalog());
      }
      listRequests.push(params);
      return HttpResponse.json(
        makeAgentCatalog({
          agents: [makeAgent({ id: "listed-1", name: "Listed agent" })],
        }),
      );
    }),
  );

  renderPage();

  expect(await screen.findByText("Listed agent")).toBeInTheDocument();
  expect(listRequests).toHaveLength(1);
  expect(listRequests[0].get("excludeIds")).toBe("personal-1");
});

it("renders the catalog the server streamed without requesting it from the browser", async () => {
  let releaseList!: () => void;
  const listHeld = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const requests: string[] = [];
  server.use(
    http.get(`${origin}/api/members/default-agent`, () =>
      HttpResponse.json({ defaultAgentId: null, personalChatAgentId: null }),
    ),
    http.get(`${origin}/api/agent-catalog`, async ({ request }) => {
      const params = new URL(request.url).searchParams;
      requests.push(`pinned=${params.get("pinned")}`);
      if (params.get("pinned") === "true") {
        return HttpResponse.json(
          makeAgentCatalog({
            agents: [makeAgent({ id: "pinned-1", name: "Pinned helper" })],
          }),
        );
      }
      await listHeld;
      return HttpResponse.json(
        makeAgentCatalog({
          agents: [makeAgent({ id: "listed-1", name: "Streamed agent" })],
        }),
      );
    }),
  );
  // What the server component does, against the same API.
  const streamed = await streamAgentCatalog({});
  expect(streamed).not.toBeNull();
  await waitFor(() => expect(requests).toHaveLength(2));
  const serverRequests = requests.splice(0);

  renderPage(undefined, (page) => (
    <StreamedQueries state={streamed as NonNullable<typeof streamed>}>
      {page}
    </StreamedQueries>
  ));

  expect(await screen.findByText("Pinned helper")).toBeInTheDocument();
  expect(screen.queryByText("No agents found")).not.toBeInTheDocument();
  releaseList();
  expect(await screen.findByText("Streamed agent")).toBeInTheDocument();
  expect(serverRequests.sort()).toEqual(["pinned=false", "pinned=true"]);
  expect(requests).toEqual([]);
});

it("commits the header and the table's placeholder before rows already in the cache", async () => {
  server.use(
    http.get(`${origin}/api/agent-catalog`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("pinned") === "true"
          ? makeAgentCatalog({
              agents: [makeAgent({ id: "pinned-1", name: "Cached pin" })],
            })
          : makeAgentCatalog({
              agents: [makeAgent({ id: "listed-1", name: "Cached agent" })],
            }),
      ),
    ),
  );
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) =>
    mutations.push(...records),
  );
  observer.observe(document.body, { childList: true, subtree: true });

  // As on a repeat visit: the default view's lists are restored before the
  // page renders.
  renderPage(
    { defaultAgentId: null, personalChatAgentId: null },
    undefined,
    (client) => {
      const key = (query: Parameters<typeof agentCatalogListQuery>[0]) =>
        agentCatalogQueryKeys.list(agentCatalogListQuery(query));
      client.setQueryData(
        key(
          agentListQuery({
            filters: DEFAULT_CATALOG_FILTERS,
            pageIndex: 0,
            pageSize: DEFAULT_TABLE_LIMIT,
            isDeletedView: false,
            excludeIds: undefined,
          }),
        ),
        makeAgentCatalog({
          agents: [makeAgent({ id: "listed-1", name: "Cached agent" })],
        }),
      );
      client.setQueryData(
        key(pinnedAgentsQuery(DEFAULT_CATALOG_FILTERS)),
        makeAgentCatalog({
          agents: [makeAgent({ id: "pinned-1", name: "Cached pin" })],
        }),
      );
    },
  );

  await waitFor(() =>
    expect(screen.getByText("Cached agent")).toBeInTheDocument(),
  );
  observer.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The placeholder table was on screen with the header, then gave way to the
  // rows: without the deferred pass the rows would be in the first commit.
  const removedPlaceholder = mutations.some((record) =>
    [...record.removedNodes].some(
      (node) =>
        node instanceof HTMLElement &&
        (node.matches('table[aria-busy="true"]') ||
          !!node.querySelector('table[aria-busy="true"]')),
    ),
  );
  expect(removedPlaceholder).toBe(true);
  expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
});
