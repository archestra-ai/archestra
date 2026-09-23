import {
  ARCHESTRA_MCP_CATALOG_ID,
  archestraApiClient,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  test,
  vi,
} from "vitest";
import { OverviewTab } from "./overview-tab";

vi.mock("next/navigation");
vi.mock("sonner");

const origin = "http://localhost:9000";
const entityId = "f12fd5c7-d482-4a3b-9971-bbe81ca4fdf0";
const serverId = "e8340e76-19fc-444d-ac4e-a817c1e78c3c";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/openappa");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  server.use(
    http.get(`${origin}/api/openappa/coverage/entities`, () =>
      HttpResponse.json({
        data: [
          {
            id: entityId,
            name: "Research assistant",
            type: "agent",
            scope: "org",
            icon: null,
            toolCount: 3,
            governedCount: 2,
            fallbackCount: 1,
            builtInCount: 1,
            autoMode: true,
          },
          {
            id: serverId,
            name: "GitHub",
            type: "mcp_server",
            scope: "personal",
            icon: null,
            toolCount: 19,
            governedCount: 4,
            fallbackCount: 15,
            builtInCount: 0,
            autoMode: false,
          },
        ],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 2,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      }),
    ),
    http.get(`${origin}/api/openappa/coverage/tools`, ({ request }) => {
      const catalogId = new URL(request.url).searchParams.get("catalogId");
      const data = [
        {
          toolId: "tool-1",
          catalogId: ARCHESTRA_MCP_CATALOG_ID,
          catalogName: "Archestra",
          catalogIcon: null,
          prefix: "archestra",
          name: "search_tools",
          fullName: "archestra__search_tools",
          kind: "unlisted",
          policySource: "built_in",
          rule: null,
          unlisted: true,
          enforced: false,
          agents: [],
        },
        {
          toolId: "tool-2",
          catalogId: serverId,
          catalogName: "GitHub",
          catalogIcon: "🐙",
          prefix: "github",
          name: "get_issue",
          fullName: "github__get_issue",
          kind: "unlisted",
          policySource: "fallback",
          rule: null,
          unlisted: true,
          enforced: false,
          agents: [],
        },
      ].filter((tool) => !catalogId || tool.catalogId === catalogId);
      return HttpResponse.json({
        data,
        servers: [
          { id: ARCHESTRA_MCP_CATALOG_ID, name: "Archestra", icon: null },
          { id: serverId, name: "GitHub", icon: "🐙" },
        ],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: data.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });
    }),
    http.get(`${origin}/api/internal_mcp_catalog`, () => HttpResponse.json([])),
    http.get(`${origin}/api/organization/appearance-settings`, () =>
      HttpResponse.json({}),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test("shows agents and registry servers with combined tool coverage and scoped details", async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OverviewTab />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Research assistant")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Policy targets" })).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "Type" })).toBeVisible();
  expect(
    screen.getByRole("columnheader", { name: "Visibility" }),
  ).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "Tools" })).toBeVisible();
  expect(screen.getByText("2 of 3 with tool rules")).toBeVisible();
  expect(screen.getByText("Includes your Auto mode access")).toBeVisible();
  expect(screen.getByText("4 of 19 with tool rules")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Details for Research assistant" }),
  );
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Organization · 3 tools reachable for you · 2 with active explicit rules · 1 may use the catch-all · 1 built-in tool",
  );
  expect(await screen.findByText("Built-in fallback")).toBeVisible();
  const dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByRole("columnheader", { name: "MCP server" }),
  ).toBeVisible();
  expect(
    within(dialog).getByRole("columnheader", { name: "Tool name" }),
  ).toBeVisible();
  expect(within(dialog).getByText("GitHub")).toBeVisible();
  expect(within(dialog).getByText("🐙")).toBeVisible();
  await userEvent.click(
    await within(dialog).findByRole("combobox", { name: "MCP server" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "GitHub" }));
  await waitFor(() => {
    expect(within(dialog).getByText("get_issue")).toBeVisible();
    expect(within(dialog).queryByText("search_tools")).not.toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Details for GitHub" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "MCP server · Personal · 19 synced tools · 4 with active explicit rules",
  );
  expect(await screen.findByText("get_issue")).toBeVisible();
});
