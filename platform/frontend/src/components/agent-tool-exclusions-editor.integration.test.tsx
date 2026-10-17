import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { AgentToolExclusionsEditor } from "./agent-tool-exclusions-editor";

// The combobox positions itself with floating-ui, which constructs a
// ResizeObserver; jsdom has none.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const API_ORIGIN = "http://localhost:9000";
const AGENT_ID = "agent-1";
const CATALOG_ID = "catalog-1";
const TOOL_ID = "tool-1";

type CatalogItem =
  archestraApiTypes.SearchMcpRegistryResponses["200"]["data"][number];
type SearchBody = NonNullable<archestraApiTypes.SearchMcpRegistryData["body"]>;

const catalogItem = {
  id: CATALOG_ID,
  name: "example-server",
  description: "An MCP server",
  serverType: "builtin",
  scope: "org",
  toolCount: 1,
  labels: [],
  teams: [],
  skillCount: 0,
  icon: null,
  iconUrl: null,
} as unknown as CatalogItem;

const server = setupServer();

/** The registry search route over `rows`, by id or by name. */
function registrySearch(
  rows: CatalogItem[],
  onRequest?: (body: SearchBody) => unknown,
) {
  return http.post(
    `${API_ORIGIN}/api/internal_mcp_catalog/registry/search`,
    async ({ request }) => {
      const body = (await request.json()) as SearchBody;
      await onRequest?.(body);
      const matching = rows.filter(
        (row) =>
          (!body.catalogIds || body.catalogIds.includes(row.id)) &&
          (!body.search ||
            row.name.toLowerCase().includes(body.search.toLowerCase())),
      );
      const limit = body.limit ?? 20;
      return HttpResponse.json({
        data: matching.slice(0, limit),
        pagination: { total: matching.length, limit, currentPage: 1 },
        selectableTotal: 0,
        installs: [],
      });
    },
  );
}

/**
 * Everything the editor reads EXCEPT the batched tool list, which each test
 * installs for itself — how the editor behaves without it is the point.
 */
function baseHandlers() {
  return [
    registrySearch([catalogItem]),
    http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}/tool-exclusions`, () =>
      HttpResponse.json({ excludedToolIds: [TOOL_ID] }),
    ),
    http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}/tools`, () =>
      HttpResponse.json([]),
    ),
    http.get(`${API_ORIGIN}/api/organization`, () =>
      HttpResponse.json({ id: "org-1", skillToolsEnabled: false }),
    ),
    http.get(`${API_ORIGIN}/api/organization/appearance-settings`, () =>
      HttpResponse.json({}),
    ),
    http.get(`${API_ORIGIN}/api/config`, () => HttpResponse.json({})),
    http.get(`${API_ORIGIN}/api/config/public`, () => HttpResponse.json({})),
  ];
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.use(...baseHandlers());
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderEditor() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentToolExclusionsEditor agentId={AGENT_ID} />
    </QueryClientProvider>,
  );
}

describe("AgentToolExclusionsEditor — batched tool list failure", () => {
  it("offers a retry instead of spinning forever when the tool list fails", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/internal_mcp_catalog/tools`, () =>
        HttpResponse.json({ error: { message: "boom" } }, { status: 500 }),
      ),
    );

    renderEditor();

    // The editor deliberately does not fall back to an empty tool list — that
    // would resolve every saved exclusion to `unresolvedToolIds` and render as
    // "nothing is disabled here". So the failure has to be surfaced, not left
    // indistinguishable from a slow load.
    expect(
      await screen.findByTestId("retry-exclusions-tools"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Loading exclusions/i)).not.toBeInTheDocument();
  });

  it("recovers the saved exclusions when the retry succeeds", async () => {
    let attempt = 0;
    server.use(
      http.get(`${API_ORIGIN}/api/internal_mcp_catalog/tools`, () => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(
            { error: { message: "boom" } },
            { status: 500 },
          );
        }
        return HttpResponse.json([
          { id: TOOL_ID, name: "example__do_thing", catalogId: CATALOG_ID },
        ]);
      }),
    );

    const user = userEvent.setup();
    renderEditor();

    await user.click(await screen.findByTestId("retry-exclusions-tools"));

    // The saved exclusion resolves to its server's pill, which is exactly what
    // the failed first attempt could not show.
    expect(await screen.findByText(/1\/1 disabled/)).toBeInTheDocument();
  });
});

describe("AgentToolExclusionsEditor — catalogs", () => {
  it("shows a disabled server beyond the first page, and finds others by searching", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...catalogItem,
      id: `catalog-${String(i).padStart(2, "0")}`,
      name: `server-${String(i).padStart(2, "0")}`,
    }));
    const requests: SearchBody[] = [];
    server.use(
      registrySearch(many, (body) => requests.push(body)),
      http.get(`${API_ORIGIN}/api/internal_mcp_catalog/tools`, () =>
        HttpResponse.json([
          { id: TOOL_ID, name: "server_79__do_thing", catalogId: "catalog-79" },
          { id: "tool-2", name: "server_65__x", catalogId: "catalog-65" },
        ]),
      ),
    );

    const user = userEvent.setup();
    renderEditor();

    // The saved exclusion's server is fetched by id, not found on a page.
    expect(await screen.findByText("server-79")).toBeInTheDocument();
    expect(
      requests.some((body) => body.catalogIds?.includes("catalog-79")),
    ).toBe(true);
    expect(requests.every((body) => (body.limit ?? 0) <= 100)).toBe(true);

    await user.click(screen.getByRole("button", { name: /disable tools/i }));
    // Beyond the first page of 50: only a server-side search finds it.
    expect(
      screen.queryByRole("menuitemcheckbox", { name: /server-65/ }),
    ).toBeNull();
    await user.type(screen.getByPlaceholderText(/search mcp servers/i), "65");

    expect(
      await screen.findByRole("menuitemcheckbox", { name: /server-65/ }),
    ).toBeInTheDocument();
    expect(requests.some((body) => body.search === "65")).toBe(true);
  });

  it("keeps the editor on screen while a newly disabled server's row loads", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...catalogItem,
      id: `catalog-${String(i).padStart(2, "0")}`,
      name: `server-${String(i).padStart(2, "0")}`,
    }));
    // The by-id read that adds server-65 waits until the test lets it go.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      registrySearch(many, async (body) => {
        if (body.catalogIds?.includes("catalog-65")) await gate;
      }),
      http.get(`${API_ORIGIN}/api/internal_mcp_catalog/tools`, () =>
        HttpResponse.json([
          { id: TOOL_ID, name: "server_79__do_thing", catalogId: "catalog-79" },
          { id: "tool-2", name: "server_65__x", catalogId: "catalog-65" },
        ]),
      ),
    );

    const user = userEvent.setup();
    renderEditor();
    expect(await screen.findByText("server-79")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /disable tools/i }));
    await user.type(screen.getByPlaceholderText(/search mcp servers/i), "65");
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /server-65/ }),
    );

    // The by-id set changed; the known pill stays and nothing reloads.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/Loading exclusions/i)).not.toBeInTheDocument();
    expect(screen.getByText("server-79")).toBeInTheDocument();
    release();
  });
});
