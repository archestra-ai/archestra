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
    id: `agent-${index}`,
    name: `Usage Agent ${String(index + 1).padStart(3, "0")}`,
    agentType: "agent",
    scope: "org",
    ownerId: null,
    ownerEmail: null,
    access: index % 2 ? "auto" : "assigned",
  }));
  server.use(
    http.get(
      "http://localhost:9000/api/mcp_server/agent_usage",
      ({ request }) => {
        const query = new URL(request.url).searchParams;
        const search = query.get("search") ?? "";
        const rows = agents.filter((agent) => agent.name.includes(search));
        if (query.get("sortDirection") === "desc") rows.reverse();
        const limit = Number(query.get("limit"));
        const offset = Number(query.get("offset"));
        return HttpResponse.json([
          {
            catalogId,
            data: rows.slice(offset, offset + limit),
            assignedCount: rows.filter((row) => row.access === "assigned")
              .length,
            autoCount: rows.filter((row) => row.access === "auto").length,
            assignedPreview: [],
            autoPreview: [],
            pagination: {
              total: rows.length,
              limit,
              currentPage: Math.floor(offset / limit) + 1,
              totalPages: Math.ceil(rows.length / limit),
              hasNext: offset + limit < rows.length,
              hasPrev: offset > 0,
            },
          },
        ]);
      },
    ),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <McpServerPagedUsageTab catalogId={catalogId} />
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
