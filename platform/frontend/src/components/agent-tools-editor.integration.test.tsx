import {
  ARCHESTRA_MCP_CATALOG_ID,
  archestraApiClient,
  type archestraApiTypes,
  TOOL_TODO_WRITE_FULL_NAME,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
import { authQueryKeys } from "@/lib/auth/auth.query";
import { AgentToolsEditor } from "./agent-tools-editor";

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

type CatalogItem =
  archestraApiTypes.SearchMcpRegistryResponses["200"]["data"][number];
type SearchBody = NonNullable<archestraApiTypes.SearchMcpRegistryData["body"]>;

/**
 * A server with a large tool set. `builtin` keeps the picker's connectivity
 * gate out of the way (built-ins need no install or credential), leaving tool
 * discovery as the only thing that decides whether it is offerable — which is
 * exactly what these tests are about.
 */
const catalogItem = {
  id: CATALOG_ID,
  name: "example-server",
  description: "An MCP server with a lot of tools",
  serverType: "builtin",
  scope: "org",
  toolCount: 150,
  labels: [],
  teams: [],
  skillCount: 0,
  icon: null,
  iconUrl: null,
  docsUrl: null,
  enterpriseManaged: false,
  environmentId: null,
} as unknown as CatalogItem;

const server = setupServer();

/**
 * The registry search route over `rows`: the picker's two reads are the
 * record's catalogs by id and one page of the registry, searched by name.
 */
function registrySearch(
  rows: CatalogItem[],
  onRequest?: (body: SearchBody) => void,
) {
  return http.post(
    `${API_ORIGIN}/api/internal_mcp_catalog/registry/search`,
    async ({ request }) => {
      const body = (await request.json()) as SearchBody;
      onRequest?.(body);
      const matching = rows.filter(
        (row) =>
          (!body.catalogIds || body.catalogIds.includes(row.id)) &&
          (!body.search ||
            row.name.toLowerCase().includes(body.search.toLowerCase())),
      );
      const offset = body.offset ?? 0;
      const limit = body.limit ?? 20;
      return HttpResponse.json({
        data: matching.slice(offset, offset + limit),
        pagination: {
          currentPage: 1,
          limit,
          total: matching.length,
          totalPages: Math.ceil(matching.length / limit),
          hasNext: offset + limit < matching.length,
          hasPrev: offset > 0,
        },
        selectableTotal: 0,
        installs: [],
      });
    },
  );
}

/**
 * Everything the editor reads EXCEPT the per-catalog tool lists, which each
 * test installs for itself — what the editor can render without them is the
 * point.
 */
function baseHandlers() {
  return [
    registrySearch([catalogItem]),
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

function renderEditor(seed?: (client: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentToolsEditor agentId={AGENT_ID} />
    </QueryClientProvider>,
  );
}

describe("AgentToolsEditor", () => {
  it("preselects creation defaults using only compact catalog metadata", async () => {
    const selected: string[][] = [];
    const views: (string | null)[] = [];
    server.use(
      registrySearch([
        {
          ...catalogItem,
          id: ARCHESTRA_MCP_CATALOG_ID,
          name: "Platform tools",
          toolCount: 2,
        },
      ]),
      http.get(`${API_ORIGIN}/api/mcp_server`, () => HttpResponse.json([])),
      http.get(
        `${API_ORIGIN}/api/internal_mcp_catalog/:id/tools`,
        ({ request }) => {
          const view = new URL(request.url).searchParams.get("view");
          views.push(view);
          if (view !== "picker") return new Promise<never>(() => {});
          return HttpResponse.json([
            {
              id: "default-tool",
              name: TOOL_TODO_WRITE_FULL_NAME,
              description: "Plan work",
              createdAt: new Date().toISOString(),
              group: null,
            },
            {
              id: "optional-tool",
              name: "archestra__optional_example",
              description: "Optional tool",
              createdAt: new Date().toISOString(),
              group: null,
            },
          ]);
        },
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <AgentToolsEditor
          onSelectedToolIdsChange={(ids) => selected.push([...ids])}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(selected.at(-1)).toEqual(["default-tool"]));
    expect(views).toEqual(["picker"]);
    client.clear();
  });

  it("surfaces a failed catalog list instead of reporting an empty registry", async () => {
    // The catalog list is the only thing this picker cannot render without,
    // and a failed one leaves it empty — which the emptiness gate reports as
    // "no MCP servers", indistinguishable from an organization that genuinely
    // has none. The query is silent by design (`toastOnError: false`), so
    // nothing else on screen contradicts it.
    let catalogRequests = 0;
    server.use(
      http.post(
        `${API_ORIGIN}/api/internal_mcp_catalog/registry/search`,
        () => {
          catalogRequests += 1;
          return catalogRequests === 1
            ? HttpResponse.json({ error: { message: "boom" } }, { status: 500 })
            : undefined;
        },
      ),
    );

    const user = userEvent.setup();
    renderEditor();

    expect(
      await screen.findByText(/couldn't load the MCP server catalog/i),
    ).toBeTruthy();
    expect(screen.queryByText(/No MCP servers available/i)).toBeNull();

    // Recoverable without reloading the page.
    await user.click(await screen.findByTestId("retry-tools-catalog"));

    expect(screen.queryByTestId("retry-tools-catalog")).toBeNull();
    await user.click(await screen.findByRole("button", { name: /add/i }));
    expect(
      await screen.findByRole("menuitemcheckbox", { name: /example-server/ }),
    ).toBeTruthy();
  });

  it("offers each server with its tool count while no tool list has loaded", async () => {
    // Tool lists that never answer — the shape of the bug this guards. The
    // picker used to fetch every catalog's full tool list on mount just to
    // read its length, so a registry of any size left it stuck behind that
    // fan-out. The count is now list metadata, so the picker is usable
    // before (and without) any tool list.
    let toolListRequests = 0;
    server.use(
      http.get(`${API_ORIGIN}/api/internal_mcp_catalog/:id/tools`, () => {
        toolListRequests += 1;
        return new Promise<never>(() => {});
      }),
      http.get(
        `${API_ORIGIN}/api/internal_mcp_catalog/tools`,
        () => new Promise<never>(() => {}),
      ),
    );

    const user = userEvent.setup();
    renderEditor();

    await user.click(await screen.findByRole("button", { name: /add/i }));

    const option = await screen.findByRole("menuitemcheckbox", {
      name: /example-server/,
    });
    // "150 tools", not the greyed-out "Not installed" a zero count produces.
    expect(option).toHaveTextContent("150 tools");
    expect(option).not.toHaveTextContent("Not installed");
    expect(toolListRequests).toBe(0);
  });

  it("counts a server's assigned tools against the count from the catalog list", async () => {
    let toolRequests = 0;
    server.use(
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}/tools`, () =>
        HttpResponse.json([
          {
            id: "tool-1",
            name: "example__one",
            catalogId: CATALOG_ID,
            mcpServerId: null,
            credentialResolutionMode: "dynamic",
          },
          {
            id: "tool-2",
            name: "example__two",
            catalogId: CATALOG_ID,
            mcpServerId: null,
            credentialResolutionMode: "dynamic",
          },
        ]),
      ),
      http.get(`${API_ORIGIN}/api/internal_mcp_catalog/:id/tools`, () => {
        toolRequests += 1;
        return new Promise<never>(() => {});
      }),
    );

    const user = userEvent.setup();
    renderEditor();

    await user.click(await screen.findByRole("button", { name: /add/i }));

    expect(
      await screen.findByRole("menuitemcheckbox", { name: /example-server/ }),
    ).toHaveTextContent("2/150");
    expect(toolRequests).toBe(0);
  });

  it("offers the registry a page at a time and finds the rest by searching", async () => {
    // A registry far larger than the Add list shows: only one page loads up
    // front, and a server beyond it is found by asking the server, not by
    // filtering what happened to load.
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...catalogItem,
      id: `catalog-${String(i).padStart(2, "0")}`,
      name: `server-${String(i).padStart(2, "0")}`,
    }));
    const requests: SearchBody[] = [];
    server.use(registrySearch(many, (body) => requests.push(body)));

    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole("button", { name: /add/i }));

    expect(
      await screen.findByRole("menuitemcheckbox", { name: /server-00/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: /server-79/ }),
    ).toBeNull();
    expect(requests.every((body) => (body.limit ?? 0) <= 50)).toBe(true);

    await user.type(screen.getByPlaceholderText(/search mcp servers/i), "79");

    expect(
      await screen.findByRole("menuitemcheckbox", { name: /server-79/ }),
    ).toBeTruthy();
    expect(requests.some((body) => body.search === "79")).toBe(true);
  });

  it("shows a server the record uses even when the first page does not hold it", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...catalogItem,
      id: `catalog-${String(i).padStart(2, "0")}`,
      name: `server-${String(i).padStart(2, "0")}`,
    }));
    const requests: SearchBody[] = [];
    server.use(
      registrySearch(many, (body) => requests.push(body)),
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}/tools`, () =>
        HttpResponse.json([
          {
            id: "tool-1",
            name: "server_79__one",
            catalogId: "catalog-79",
            mcpServerId: null,
            credentialResolutionMode: "dynamic",
          },
        ]),
      ),
      http.get(
        `${API_ORIGIN}/api/internal_mcp_catalog/:id/tools`,
        () => new Promise<never>(() => {}),
      ),
    );

    renderEditor();

    expect(await screen.findByText("server-79")).toBeTruthy();
    expect(
      requests.some(
        (body) =>
          body.catalogIds?.length === 1 && body.catalogIds[0] === "catalog-79",
      ),
    ).toBe(true);
  });

  it("checks connections only for the servers on screen", async () => {
    // Remote servers need an install the record can use; the gate asks for
    // those installs by catalog, not for every install in the organization.
    const remote = (id: string, name: string): CatalogItem => ({
      ...catalogItem,
      id,
      name,
      serverType: "remote",
    });
    const installRequests: URLSearchParams[] = [];
    server.use(
      registrySearch([
        remote("catalog-connected", "connected-server"),
        remote("catalog-unconnected", "unconnected-server"),
      ]),
      http.get(`${API_ORIGIN}/api/mcp_server`, ({ request }) => {
        installRequests.push(new URL(request.url).searchParams);
        return HttpResponse.json([
          {
            id: "install-1",
            name: "connected-server",
            catalogId: "catalog-connected",
            ownerId: "user-1",
            scope: "org",
          },
        ]);
      }),
    );

    const user = userEvent.setup();
    renderEditor((client) => {
      // A signed-in reader who may read installs.
      client.setQueryData(authQueryKeys.session(), {
        user: { id: "user-1" },
        session: {},
      });
      client.setQueryData(authQueryKeys.userPermissions(), {
        mcpServerInstallation: ["read"],
      });
      client.setQueryData(["config"], { features: {} });
    });
    await user.click(await screen.findByRole("button", { name: /add/i }));

    expect(
      await screen.findByRole("menuitemcheckbox", {
        name: /unconnected-server/,
      }),
    ).toHaveTextContent("Not connected");
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemcheckbox", { name: /^connected-server/ }),
      ).toHaveTextContent("150 tools"),
    );
    expect(installRequests.length).toBeGreaterThan(0);
    for (const params of installRequests) {
      expect(params.get("catalogIds")?.split(",").sort()).toEqual([
        "catalog-connected",
        "catalog-unconnected",
      ]);
    }
  });
});
