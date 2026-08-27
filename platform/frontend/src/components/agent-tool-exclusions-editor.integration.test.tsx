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
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

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
} as unknown as CatalogItem;

const server = setupServer();

/**
 * Everything the editor reads EXCEPT the batched tool list, which each test
 * installs for itself — how the editor behaves without it is the point.
 */
function baseHandlers() {
  return [
    http.get(`${API_ORIGIN}/api/internal_mcp_catalog`, () =>
      HttpResponse.json([catalogItem]),
    ),
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
