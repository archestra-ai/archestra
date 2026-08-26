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
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

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
} as unknown as CatalogItem;

const server = setupServer();

/**
 * Everything the editor reads EXCEPT the per-catalog tool lists, which each
 * test installs for itself — what the editor can render without them is the
 * point.
 */
function baseHandlers() {
  return [
    http.get(`${API_ORIGIN}/api/internal_mcp_catalog`, () =>
      HttpResponse.json([catalogItem]),
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
      <AgentToolsEditor agentId={AGENT_ID} />
    </QueryClientProvider>,
  );
}

describe("AgentToolsEditor", () => {
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
      http.get(
        `${API_ORIGIN}/api/internal_mcp_catalog/:id/tools`,
        () => new Promise<never>(() => {}),
      ),
    );

    const user = userEvent.setup();
    renderEditor();

    await user.click(await screen.findByRole("button", { name: /add/i }));

    expect(
      await screen.findByRole("menuitemcheckbox", { name: /example-server/ }),
    ).toHaveTextContent("2/150");
  });
});
