import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import {
  agentDetailHref,
  agentPageKindForType,
} from "@/components/agent-pages/agent-page-config";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { McpServerPagedUsageTab } from "./mcp-server-usage-tab";

vi.mock("@/lib/auth/auth.query");
const server = setupServer();
const catalogId = "00000000-0000-4000-8000-000000000001";
const VIEWER_ID = "viewer";
let client: QueryClient;
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  cleanup();
  client?.clear();
  server.resetHandlers();
});
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: VIEWER_ID } },
  } as ReturnType<typeof useSession>);
});

test("picked agents lead in their own strip while All-tools agents page below", async () => {
  const picked = Array.from({ length: 3 }, (_, index) =>
    agent({
      id: uuid(index),
      name: `Picked ${index + 1}`,
      accessAllTools: false,
    }),
  );
  const automatic = Array.from({ length: 25 }, (_, index) =>
    agent({
      id: uuid(100 + index),
      name: `Auto ${String(index + 1).padStart(2, "0")}`,
    }),
  );
  autoModeServes(automatic);
  renderTab([{ assignedAgents: picked }]);

  expect(await screen.findByText("Auto 01")).toBeInTheDocument();
  expect(
    screen.getByText(/agents and MCP gateways can reach this server/),
  ).toHaveTextContent("28 agents and MCP gateways can reach this server");
  const strip = within(
    screen
      .getByRole("heading", { name: "Picked tools from this server" })
      .closest("section") as HTMLElement,
  );
  expect(strip.getByText("Picked 1")).toBeInTheDocument();
  expect(screen.queryByText("Auto 21")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
  expect(await screen.findByText("Auto 21")).toBeInTheDocument();
  expect(screen.queryByText("Auto 01")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Go to next page" }),
  ).toBeDisabled();

  fireEvent.change(
    screen.getByRole("textbox", { name: "Filter by name or owner" }),
    {
      target: { value: "Auto 07" },
    },
  );
  expect(await screen.findByText("Auto 07")).toBeInTheDocument();
  expect(screen.queryByText("Picked 1")).not.toBeInTheDocument();
});

test("each agent's name opens its detail page", async () => {
  autoModeServes([
    agent({ id: uuid(1), name: "Roaming Gateway", agentType: "mcp_gateway" }),
  ]);
  renderTab([]);

  const link = await screen.findByRole("link", { name: "Roaming Gateway" });
  expect(link).toHaveAttribute(
    "href",
    agentDetailHref(agentPageKindForType("mcp_gateway"), uuid(1)),
  );
});

test("says whose each agent is, in words rather than enums", async () => {
  autoModeServes([]);
  renderTab([
    {
      assignedAgents: [
        agent({
          id: uuid(1),
          name: "Mine",
          scope: "personal",
          ownerId: VIEWER_ID,
          ownerEmail: "me@example.com",
        }),
        agent({
          id: uuid(2),
          name: "Alice's",
          scope: "personal",
          ownerId: "alice",
          ownerEmail: "alice@example.com",
        }),
        agent({ id: uuid(3), name: "Orphaned", scope: "personal" }),
        agent({ id: uuid(4), name: "Shared", scope: "org" }),
      ],
    },
  ]);

  await screen.findByRole("link", { name: "Mine" });
  expect(card("Mine").getByText("You")).toBeInTheDocument();
  expect(card("Alice's").getByText("alice@example.com")).toBeInTheDocument();
  // A personal agent whose author is gone must not read like the viewer's own.
  expect(card("Orphaned").getByText("Deleted user")).toBeInTheDocument();
  expect(card("Shared").getByText("Organization")).toBeInTheDocument();
  expect(screen.queryByText("org")).not.toBeInTheDocument();
});

test("lists an agent once however many ways it reaches the server", async () => {
  const hybrid = agent({ id: uuid(1), name: "Hybrid" });
  autoModeServes([hybrid, agent({ id: uuid(2), name: "Only auto" })]);
  renderTab([{ assignedAgents: [hybrid] }, { assignedAgents: [hybrid] }]);

  expect(await screen.findByText("Only auto")).toBeInTheDocument();
  expect(screen.getAllByText("Hybrid")).toHaveLength(1);
});

test("explains the empty case instead of rendering an empty list", async () => {
  autoModeServes([]);
  renderTab([]);

  expect(
    await screen.findByText("No agents or MCP gateways use this server yet"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

test("catalog cards share one global preview and only a dense catalog needs a fallback", async () => {
  const { useMcpUsageSummary } = await import(
    "@/lib/mcp/mcp-agent-usage.query"
  );
  const all = Array.from({ length: 105 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: `Auto ${String(i).padStart(3, "0")}`,
    agentType: "agent" as const,
    scope: "org" as const,
    ownerId: null,
    ownerEmail: null,
    organizationId: "org",
    accessAllTools: true,
  }));
  const sparse = all.slice(0, 1),
    dense = all.slice(0, 100);
  const denseCatalog = "00000000-0000-4000-8000-000000000002";
  let summaries = 0,
    globalPreviews = 0;
  const fallbacks: string[] = [];
  server.use(
    http.get(
      "http://localhost:9000/api/mcp_server/auto_mode_agents/page",
      ({ request }) => {
        const query = new URL(request.url).searchParams;
        const limit = Number(query.get("limit") ?? 20);
        if (query.get("summary") === "true") {
          summaries++;
          return HttpResponse.json({
            data: [],
            totalAutoCount: all.length,
            organizationId: "org",
            pagination: { limit, hasNext: false, nextCursor: null },
          });
        }
        const catalog = query.get("catalogId");
        if (catalog) fallbacks.push(catalog);
        else globalPreviews++;
        const rows = catalog ? all.slice(100) : all;
        return HttpResponse.json({
          data: rows.slice(0, limit),
          pagination: {
            limit,
            hasNext: rows.length > limit,
            nextCursor: rows.length > limit ? "more" : null,
          },
        });
      },
    ),
  );
  function Card({ id, assigned }: { id: string; assigned: typeof all }) {
    const { data } = useMcpUsageSummary({
      catalogId: id,
      assignedAgents: assigned,
    });
    return (
      <section aria-label={id}>
        <p>{data?.pagination.total} total</p>
        {data?.autoPreview.map((agent) => (
          <p key={agent.id}>{agent.name}</p>
        ))}
      </section>
    );
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Card id={catalogId} assigned={sparse} />
      <Card id={denseCatalog} assigned={dense} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Auto 001")).toBeInTheDocument();
  expect(await screen.findByText("Auto 100")).toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: catalogId })).queryByText(
      "Auto 000",
    ),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: catalogId })).getAllByText(
      /^Auto/,
    ),
  ).toHaveLength(8);
  expect(
    within(screen.getByRole("region", { name: denseCatalog })).getAllByText(
      /^Auto/,
    ),
  ).toHaveLength(5);
  expect(summaries).toBe(1);
  expect(globalPreviews).toBe(1);
  expect(fallbacks).toEqual([denseCatalog]);
});

// ===

function renderTab(
  serversForCatalog: Array<{ assignedAgents: ReturnType<typeof agent>[] }>,
) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <McpServerPagedUsageTab
        catalogId={catalogId}
        serversForCatalog={serversForCatalog}
      />
    </QueryClientProvider>,
  );
}

/** Serves the auto-mode feed: a count summary, and name-ordered keyset pages. */
function autoModeServes(agents: ReturnType<typeof agent>[]) {
  server.use(
    http.get(
      "http://localhost:9000/api/mcp_server/auto_mode_agents/page",
      ({ request }) => {
        const query = new URL(request.url).searchParams;
        const search = query.get("search") ?? "";
        const limit = Number(query.get("limit") ?? 20);
        const rows = agents.filter((row) => row.name.includes(search));
        if (query.get("summary") === "true")
          return HttpResponse.json({
            data: [],
            totalAutoCount: rows.length,
            organizationId: "org",
            pagination: { limit, hasNext: false, nextCursor: null },
          });
        const boundary = agents.find(
          (row) => row.id === query.get("afterAgentId"),
        );
        const after = rows.filter(
          (row) => !boundary || row.name > boundary.name,
        );
        return HttpResponse.json({
          data: after.slice(0, limit),
          pagination: {
            limit,
            hasNext: after.length > limit,
            nextCursor: null,
          },
        });
      },
    ),
  );
}

/** The name and owner beside the link to `name`. */
function card(name: string) {
  return within(
    screen.getByRole("link", { name }).parentElement as HTMLElement,
  );
}

function agent(
  overrides: Partial<{
    id: string;
    name: string;
    agentType: "agent" | "mcp_gateway";
    scope: "org" | "team" | "personal";
    ownerId: string | null;
    ownerEmail: string | null;
    accessAllTools: boolean;
  }> = {},
) {
  return {
    id: uuid(0),
    name: "Agent",
    agentType: "agent" as const,
    scope: "org" as const,
    ownerId: null,
    ownerEmail: null,
    organizationId: "org",
    accessAllTools: true,
    pinned: true,
    ...overrides,
  };
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
