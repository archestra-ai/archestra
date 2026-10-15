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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { McpServerPagedUsageTab } from "./mcp-server-usage-tab";

vi.mock("@/lib/auth/auth.query");
const server = setupServer();
const catalogId = "00000000-0000-4000-8000-000000000001";
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
    data: { user: { id: "viewer" } },
  } as ReturnType<typeof useSession>);
});

test("Usage keeps exact group counts and retrieves later pages, searches, and reversed name order", async () => {
  const agents = Array.from({ length: 53 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Usage Agent ${String(index + 1).padStart(3, "0")}`,
    agentType: "agent" as const,
    scope: "org" as const,
    ownerId: null,
    ownerEmail: null,
    accessAllTools: index % 2 === 1 || index === 0 || index === 2,
    organizationId: index === 0 ? "other-org" : "org",
    pinned: true,
  }));
  const assigned = agents.filter((_, index) => index % 2 === 0);
  const assignedIds = new Set(assigned.map((agent) => agent.id));
  server.use(
    http.get(
      "http://localhost:9000/api/mcp_server/auto_mode_agents/page",
      ({ request }) => {
        const query = new URL(request.url).searchParams;
        const search = query.get("search") ?? "";
        const rows = agents.filter(
          (agent) =>
            agent.accessAllTools &&
            agent.organizationId === "org" &&
            agent.name.includes(search),
        );
        const limit = Number(query.get("limit") ?? 20);
        if (query.get("summary") === "true")
          return HttpResponse.json({
            data: [],
            totalAutoCount: rows.length,
            organizationId: "org",
            pagination: { limit, hasNext: false, nextCursor: null },
          });
        const descending = query.get("sortDirection") === "desc";
        const boundary = agents.find(
          (agent) => agent.id === query.get("afterAgentId"),
        );
        const after = rows.filter(
          (agent) =>
            !assignedIds.has(agent.id) &&
            (!boundary ||
              (descending
                ? agent.name < boundary.name
                : agent.name > boundary.name)),
        );
        if (descending) after.reverse();
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
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <McpServerPagedUsageTab
        catalogId={catalogId}
        serversForCatalog={[{ assignedAgents: assigned }]}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Usage Agent 001")).toBeInTheDocument();
  expect(screen.getByText(/53 agents and gateways/)).toHaveTextContent(
    "27 with Manual tool access, 26 with All.",
  );
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
    21,
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "Go to next page" })[0],
  );
  expect(await screen.findByText("Usage Agent 021")).toBeInTheDocument();
  expect(screen.queryByText("Usage Agent 001")).not.toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("Search agents or owners"), {
    target: { value: "053" },
  });
  expect(await screen.findByText("Usage Agent 053")).toBeInTheDocument();
  expect(screen.getByText(/1 agent or gateway/)).toHaveTextContent(
    "1 with Manual tool access, 0 with All.",
  );
  fireEvent.change(screen.getByPlaceholderText("Search agents or owners"), {
    target: { value: "" },
  });
  expect(await screen.findByText("Usage Agent 001")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Name: A to Z" }));
  expect(await screen.findByText("Usage Agent 053")).toBeInTheDocument();
  expect(screen.queryByText("Usage Agent 001")).not.toBeInTheDocument();
});

test("fully assigned automatic agents keep unique counts without needing an automatic-only feed", async () => {
  const assigned = [
    {
      id: "00000000-0000-4000-8000-000000000099",
      name: "Already assigned",
      agentType: "agent" as const,
      scope: "org" as const,
      ownerId: null,
      ownerEmail: null,
      accessAllTools: true,
      organizationId: "org",
      pinned: true,
    },
  ];
  server.use(
    http.get(
      "http://localhost:9000/api/mcp_server/auto_mode_agents/page",
      ({ request }) => {
        if (new URL(request.url).searchParams.get("summary") !== "true")
          return HttpResponse.json(
            { error: "No automatic-only page is needed" },
            { status: 500 },
          );
        return HttpResponse.json({
          data: [],
          totalAutoCount: 1,
          organizationId: "org",
          pagination: { limit: 20, hasNext: false, nextCursor: null },
        });
      },
    ),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <McpServerPagedUsageTab
        catalogId={catalogId}
        serversForCatalog={[{ assignedAgents: assigned }]}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Already assigned")).toBeInTheDocument();
  expect(screen.getByText(/1 agent or gateway/)).toHaveTextContent(
    "1 with Manual tool access, 0 with All.",
  );
  expect(
    screen.getByRole("button", { name: "Go to next page" }),
  ).toBeDisabled();
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
