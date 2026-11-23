import { archestraApiClient, E2eTestId } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { makeUserPermissions, sessionSeed } from "@/mocks/data/auth";
import { configSeed, makeConfig } from "@/mocks/data/config";
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

Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.releasePointerCapture = vi.fn();

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
  const page = (
    <QueryClientProvider client={client}>
      {wrap(<AgentsPage />)}
    </QueryClientProvider>
  );
  const view = render(page);
  return () =>
    view.rerender(
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

it("lists what a bookmarked Admin access, Shared with, Owner and Built-in selection asks for", async () => {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(
      "access=mine,shared,org,others&sharedWith=org&owner=user-alex&builtIn=true",
    ) as unknown as ReturnType<typeof useSearchParams>,
  );
  const listRequests: URLSearchParams[] = [];
  server.use(
    http.get(`${origin}/api/agent-catalog`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (params.get("pinned") === "false") listRequests.push(params);
      return HttpResponse.json(
        makeAgentCatalog({
          agents: [makeAgent({ id: "listed-1", name: "Listed agent" })],
        }),
      );
    }),
  );

  renderPage({ defaultAgentId: null, personalChatAgentId: null });

  await waitFor(() => expect(listRequests).toHaveLength(1));
  const [params] = listRequests;
  expect(params.toString()).toContain("others");
  expect(params.toString()).toContain("sharedWith=org");
  expect(params.toString()).toContain("owner=user-alex");
  expect(params.get("includeBuiltIn")).toBe("true");
});

it("includes matching built-in agents when searching by name", async () => {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("name=Policy%20Assistant") as unknown as ReturnType<
      typeof useSearchParams
    >,
  );
  const listRequests: URLSearchParams[] = [];
  server.use(
    http.get(`${origin}/api/agent-catalog`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (params.get("pinned") === "false") listRequests.push(params);
      return HttpResponse.json(makeAgentCatalog());
    }),
  );

  renderPage({ defaultAgentId: null, personalChatAgentId: null });

  await waitFor(() => expect(listRequests).toHaveLength(1));
  expect(listRequests[0].get("name")).toBe("Policy Assistant");
  expect(listRequests[0].get("includeBuiltIn")).toBe("true");
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

it("filters the catalog by runtime, preserves search, resets pagination and clears the selection", async () => {
  const user = userEvent.setup();
  const requests: URLSearchParams[] = [];
  let params = new URLSearchParams("runtime=codex&name=helper&page=2");
  vi.mocked(useSearchParams).mockImplementation(
    () => params as ReturnType<typeof useSearchParams>,
  );
  const push = vi.mocked(useRouter().push);
  push.mockImplementation((href) => {
    params = new URL(href, origin).searchParams;
  });
  server.use(
    http.get(`${origin}/api/agent-catalog`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      requests.push(query);
      if (query.get("pinned") === "true")
        return HttpResponse.json(makeAgentCatalog());
      const name =
        query.get("runtime") === "claude-code"
          ? "Claude helper"
          : query.get("runtime") === "codex"
            ? "Codex helper"
            : "All helpers";
      return HttpResponse.json(
        makeAgentCatalog({ agents: [makeAgent({ id: name, name })] }),
      );
    }),
  );
  const rerender = renderPage({
    defaultAgentId: null,
    personalChatAgentId: null,
  });
  expect(await screen.findByText("Codex helper")).toBeInTheDocument();
  expect(
    requests.some(
      (query) =>
        query.get("runtime") === "codex" &&
        query.get("offset") === String(DEFAULT_TABLE_LIMIT) &&
        query.get("name") === "helper",
    ),
  ).toBe(true);
  await user.click(
    screen.getByRole("combobox", { name: "Filter by agent runtime" }),
  );
  await user.click(screen.getByRole("option", { name: "Claude Code" }));
  expect(params.get("page")).toBe("1");
  expect(params.get("name")).toBe("helper");
  expect(params.get("runtime")).toBe("claude-code");
  rerender();
  expect(await screen.findByText("Claude helper")).toBeInTheDocument();
  expect(screen.queryByText("Codex helper")).not.toBeInTheDocument();
  expect(
    requests.some(
      (query) =>
        query.get("runtime") === "claude-code" &&
        query.get("pinned") === "true",
    ),
  ).toBe(true);
  await user.click(
    screen.getByRole("combobox", { name: "Filter by agent runtime" }),
  );
  await user.click(screen.getByRole("option", { name: "All runtimes" }));
  expect(params.has("runtime")).toBe(false);
  expect(params.get("name")).toBe("helper");
  rerender();
  expect(await screen.findByText("All helpers")).toBeInTheDocument();
  await user.click(
    screen.getByRole("combobox", { name: "Filter by agent runtime" }),
  );
  await user.click(screen.getByRole("option", { name: "Claude Code" }));
  rerender();
  expect(await screen.findByText("Claude helper")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(params.has("runtime")).toBe(false);
  expect(params.has("name")).toBe(false);
  rerender();
  expect(await screen.findByText("All helpers")).toBeInTheDocument();
});

it("ignores an invalid bookmarked runtime so the list remains usable", async () => {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("runtime=unknown") as ReturnType<
      typeof useSearchParams
    >,
  );
  const requests: URLSearchParams[] = [];
  server.use(
    http.get(`${origin}/api/agent-catalog`, ({ request }) => {
      requests.push(new URL(request.url).searchParams);
      return HttpResponse.json(makeAgentCatalog());
    }),
  );
  renderPage({ defaultAgentId: null, personalChatAgentId: null });
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  expect(requests.every((query) => !query.has("runtime"))).toBe(true);
  expect(
    screen.getByRole("combobox", { name: "Filter by agent runtime" }),
  ).toHaveTextContent("All runtimes");
});

/** Three agents with a runtime each, and the requests their rows make. */
function listRuntimeAgents(
  permissions: ReturnType<typeof makeUserPermissions>,
) {
  const teamRuntime = {
    id: "c0ffee00-0000-4000-8000-000000000001",
    name: "Review workspace",
    description: "",
    icon: null,
    hidden: false,
    position: 0,
    image: "registry.example.com/platform/review:v3",
  };
  const runtime = (image: string, command: string[] | null) => ({
    image,
    command,
    inferenceProtocol: "openai_responses" as const,
    backend: "kubernetes" as const,
    steerMode: "pipe" as const,
    privileged: false,
    environment: null,
    credentials: null,
    ttlHours: null,
    idleTimeoutMinutes: null,
  });
  const requests = { runtimes: 0, perRuntime: [] as string[] };
  server.use(
    http.get(`${origin}/api/config`, () =>
      HttpResponse.json(makeConfig({ features: { agentRuntime: true } })),
    ),
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json(permissions),
    ),
    http.get(`${origin}/api/agent-runtime-templates`, () => {
      requests.runtimes += 1;
      return HttpResponse.json([teamRuntime]);
    }),
    // Nothing a row shows may ask about one runtime at a time.
    http.get(`${origin}/api/agent-runtime-templates/:id`, ({ params }) => {
      requests.perRuntime.push(String(params.id));
      return HttpResponse.json(null);
    }),
    http.get(`${origin}/api/agent-catalog`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("pinned") === "true"
          ? makeAgentCatalog()
          : makeAgentCatalog({
              agents: [
                makeAgent({
                  id: "on-built-in",
                  name: "Codex helper",
                  runtime: runtime(
                    configSeed.features.agentRuntimeCatalogImages.codex,
                    ["archestra-codex"],
                  ),
                }),
                makeAgent({
                  id: "on-custom",
                  name: "Reviewer",
                  runtime: runtime(teamRuntime.image, ["review-agent"]),
                }),
                makeAgent({
                  id: "on-own-image",
                  name: "Toolbox",
                  runtime: runtime("ghcr.io/example/toolbox:latest", null),
                }),
              ],
            }),
      ),
    ),
  );
  return { requests, teamRuntime };
}

it("names each agent's runtime in its row for someone who administers runtimes, from one read of the runtimes", async () => {
  const { requests, teamRuntime } = listRuntimeAgents(makeUserPermissions());
  renderPage({ defaultAgentId: null, personalChatAgentId: null });

  const row = (name: string) =>
    screen.getByRole("link", { name }).closest("tr") as HTMLElement;
  expect(
    await screen.findByRole("link", {
      name: "Runtime: Codex, open its settings",
    }),
  ).toHaveAttribute("href", "/settings/agents/runtimes?edit=codex");
  // A custom runtime's name comes with the list of them.
  expect(
    await within(row("Reviewer")).findByRole("link", {
      name: "Runtime: Review workspace, open its settings",
    }),
  ).toHaveAttribute("href", `/settings/agents/runtimes?edit=${teamRuntime.id}`);
  expect(
    within(row("Toolbox")).getByRole("link", {
      name: "Runtime: Custom image, open runtime settings",
    }),
  ).toHaveAttribute("href", "/settings/agents/runtimes");
  // The badge takes the plain mark's place: the runtime shows once a row.
  expect(within(row("Codex helper")).getAllByText("Codex")).toHaveLength(1);
  expect(within(row("Reviewer")).queryByText("Runtime")).toBeNull();
  // One list for the whole table, and nothing per row.
  expect(requests.runtimes).toBe(1);
  expect(requests.perRuntime).toEqual([]);
});

it("keeps the plain runtime mark in each row for someone who cannot open the runtime settings, and reads no runtimes for it", async () => {
  const { requests } = listRuntimeAgents(
    makeUserPermissions({ organizationSettings: [] }),
  );
  renderPage({ defaultAgentId: null, personalChatAgentId: null });

  const row = (name: string) =>
    screen.getByRole("link", { name }).closest("tr") as HTMLElement;
  await screen.findByRole("link", { name: "Codex helper" });
  // What they saw before: a maintained runtime by name, any other as
  // "Runtime", and no link to settings they cannot open.
  expect(within(row("Codex helper")).getByText("Codex")).toBeInTheDocument();
  expect(within(row("Reviewer")).getByText("Runtime")).toBeInTheDocument();
  expect(screen.queryByText("Review workspace")).toBeNull();
  expect(screen.queryByRole("link", { name: /^Runtime: / })).toBeNull();
  expect(requests.runtimes).toBe(0);
  expect(requests.perRuntime).toEqual([]);
});
