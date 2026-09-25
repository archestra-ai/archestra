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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { openAppaChatHref } from "@/lib/openappa-routes";
import { EntitiesTable } from "./entities-table";
import { ToolTable } from "./tool-table";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");

const origin = "http://localhost:9000";
const entityId = "f12fd5c7-d482-4a3b-9971-bbe81ca4fdf0";
const serverId = "e8340e76-19fc-444d-ac4e-a817c1e78c3c";
const server = setupServer();
const entityRequests: URLSearchParams[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "test-user" } },
  } as ReturnType<typeof useSession>);
  archestraApiClient.setConfig({ baseUrl: origin });
  entityRequests.length = 0;
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/openappa");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  server.use(
    http.get(`${origin}/api/openappa/coverage/entities`, ({ request }) => {
      entityRequests.push(new URL(request.url).searchParams);
      return HttpResponse.json({
        data: [
          {
            id: entityId,
            name: "Research gateway",
            type: "mcp_gateway",
            scope: "org",
            icon: null,
            toolCount: 3,
            governedCount: 2,
            fallbackCount: 1,
            builtInCount: 1,
            rules: {
              root: 1,
              battery: 1,
              notEnforced: 0,
              catchAll: 1,
              builtInFallback: 0,
            },
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
            rules: {
              root: 0,
              battery: 4,
              notEnforced: 0,
              catchAll: 15,
              builtInFallback: 0,
            },
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
      });
    }),
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

test("lists registry servers and gateways, servers first, each with a chat and scoped details", async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <EntitiesTable />
    </QueryClientProvider>,
  );

  const targets = screen;
  expect(await targets.findByText("Research gateway")).toBeVisible();
  expect(entityRequests[0]?.get("sortBy")).toBe("type");
  expect(entityRequests[0]?.get("sortDirection")).toBe("asc");
  // One chat for every target, whatever its coverage.
  expect(
    targets.getByRole("link", { name: "Ask in chat: Research gateway" }),
  ).toHaveAttribute(
    "href",
    openAppaChatHref({
      promptKey: "reviewCoverage",
      target: { kind: "mcp_gateway", id: entityId },
    }),
  );
  expect(
    targets.getByRole("link", { name: "Ask in chat: GitHub" }),
  ).toHaveAttribute(
    "href",
    expect.stringContaining(
      `targetType=mcp_server&targetId=${serverId}&openappaPrompt=reviewCoverage&from=openappa`,
    ),
  );
  expect(targets.getByText("2 of 3 covered")).toBeVisible();
  expect(
    targets.getByRole("img", {
      name: "Custom rule: 1, Battery rule: 1, No rule: 1",
    }),
  ).toBeVisible();
  for (const header of ["Name", "Type", "Tool coverage", "Actions"])
    expect(targets.getByRole("columnheader", { name: header })).toBeVisible();
  expect(targets.getByRole("columnheader", { name: "Type" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  expect(targets.getByText("Auto mode")).toBeVisible();
  expect(targets.getByText("4 of 19 covered")).toBeVisible();
  fireEvent.click(targets.getByRole("button", { name: /Research gateway/ }));
  const researchSummary = within(await screen.findByRole("dialog"));
  for (const [value, label] of [
    ["3", "tools reachable for you"],
    ["2", "with a rule"],
    ["1", "with no rule"],
    ["1", "built-in tool"],
  ]) {
    expect(researchSummary.getByText(label).parentElement).toHaveTextContent(
      `${value}${label}`,
    );
  }
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
  fireEvent.click(targets.getByRole("button", { name: /GitHub/ }));
  const githubSummary = within(await screen.findByRole("dialog"));
  expect(
    githubSummary.getByText("synced tools").parentElement,
  ).toHaveTextContent("19synced tools");
  expect(githubSummary.queryByText(/built-in tool/)).not.toBeInTheDocument();
  expect(await screen.findByText("get_issue")).toBeVisible();
});

test("disables server chat when registry read access is missing", async () => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as ReturnType<typeof useHasPermissions>);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EntitiesTable />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("GitHub")).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Ask in chat: GitHub" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Ask in chat: GitHub" }),
  ).toHaveAttribute("aria-disabled", "true");
});

test("filters tool policy sources and links each rule to its TOML line", async () => {
  const batteryEntry = "batteries/github/appa.toml";
  const base = {
    catalogId: serverId,
    catalogName: "GitHub",
    catalogIcon: "🐙",
    prefix: "github",
    kind: "read",
    unlisted: false,
    enforced: true,
    agents: [],
    fallbackLine: null,
  };
  const rows = [
    {
      ...base,
      toolId: "tool-root",
      name: "get_file_contents",
      fullName: "github__get_file_contents",
      policySource: "root",
      rule: {
        source: "root",
        battery: null,
        batteryEntry: null,
        batteryStatus: null,
        line: 12,
        name: "github__get_file_contents",
        selector: null,
        delta: {},
        requires: {},
        annotator: null,
        enforced: true,
      },
    },
    {
      ...base,
      toolId: "tool-battery",
      name: "get_commit",
      fullName: "github__get_commit",
      policySource: "battery",
      rule: {
        source: "battery",
        battery: "github",
        batteryEntry,
        batteryStatus: "active",
        line: 4,
        name: "mcp/github/get_commit",
        selector: null,
        delta: {},
        requires: {},
        annotator: null,
        enforced: true,
      },
    },
    {
      ...base,
      toolId: "tool-fallback",
      name: "unlisted",
      fullName: "github__unlisted",
      policySource: "fallback",
      kind: "unlisted",
      rule: null,
      unlisted: true,
      enforced: false,
      fallbackLine: 23,
    },
  ];
  server.use(
    http.get(`${origin}/api/openappa/coverage/tools`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const source = params.get("governedBy");
      const battery = params.get("battery");
      return HttpResponse.json({
        data: rows.filter(
          (row) =>
            (!source ||
              (source === "catchall"
                ? row.policySource === "fallback"
                : row.policySource === source)) &&
            (!battery || row.rule?.battery === battery),
        ),
        servers: [{ id: serverId, name: "GitHub", icon: "🐙" }],
        batteries: ["github"],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: rows.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ToolTable catalogId={serverId} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("get_commit")).toBeVisible();
  expect(
    screen.getByRole("link", {
      name: "View source for Custom rule at line 12",
    }),
  ).toHaveAttribute("href", "/openappa/policy?line=12");
  const batterySource = screen.getByRole("link", {
    name: "View source for GitHub at line 4",
  });
  expect(batterySource).toHaveTextContent("GitHub");
  expect(batterySource).not.toHaveTextContent("battery");
  expect(batterySource).toHaveAttribute(
    "href",
    expect.stringContaining(
      "/openappa/policy?entry=batteries%2Fgithub%2Fappa.toml&line=4",
    ),
  );
  expect(
    screen.getByRole("link", {
      name: "View source for No rule at line 23",
    }),
  ).toHaveAttribute("href", "/openappa/policy?line=23");

  await userEvent.click(
    screen.getByRole("combobox", { name: "Policy source" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "github battery" }));
  await waitFor(() => {
    expect(screen.getByText("get_commit")).toBeVisible();
    expect(screen.queryByText("get_file_contents")).not.toBeInTheDocument();
    expect(screen.queryByText("unlisted")).not.toBeInTheDocument();
  });
});

test("renders repeated selectors from separate policy rules without duplicate row keys", async () => {
  const base = {
    toolId: "tool-shared",
    catalogId: serverId,
    catalogName: "GitHub",
    catalogIcon: null,
    prefix: "github",
    name: "get_file_contents",
    fullName: "github__get_file_contents",
    kind: "read",
    policySource: "root",
    fallbackLine: null,
    unlisted: false,
    enforced: true,
    agents: [],
    rule: {
      source: "root",
      battery: null,
      batteryEntry: null,
      batteryStatus: null,
      line: 3,
      name: "github__get_file_contents",
      selector: "trust >= verified",
      delta: {},
      requires: {},
      annotator: null,
      enforced: true,
    },
  };
  const rows = [
    base,
    { ...base, rule: { ...base.rule, line: 8 } },
    {
      ...base,
      policySource: "battery",
      rule: {
        ...base.rule,
        source: "battery",
        battery: "github",
        batteryEntry: "batteries/github/appa.toml",
        batteryStatus: "active",
        line: 3,
      },
    },
  ];
  server.use(
    http.get(`${origin}/api/openappa/coverage/tools`, () =>
      HttpResponse.json({
        data: rows,
        servers: [{ id: serverId, name: "GitHub", icon: null }],
        batteries: ["github"],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: rows.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      }),
    ),
  );
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ToolTable catalogId={serverId} />
      </QueryClientProvider>,
    );

    expect(await screen.findAllByText("when trust >= verified")).toHaveLength(
      3,
    );
    expect(
      screen.getByRole("link", {
        name: "View source for Custom rule at line 3",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: "View source for Custom rule at line 8",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "View source for GitHub at line 3" }),
    ).toBeVisible();
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(
      /same key|unique "key"/i,
    );
  } finally {
    consoleError.mockRestore();
  }
});

test("does not offer source links for a refused composition", async () => {
  server.use(
    http.get(`${origin}/api/openappa/coverage/tools`, () =>
      HttpResponse.json({
        data: [
          {
            toolId: "tool-root",
            catalogId: serverId,
            catalogName: "GitHub",
            catalogIcon: null,
            prefix: "github",
            name: "get_file_contents",
            fullName: "github__get_file_contents",
            kind: "read",
            policySource: "root",
            rule: {
              source: "root",
              battery: null,
              batteryEntry: null,
              batteryStatus: null,
              line: 12,
              name: "github__get_file_contents",
              selector: null,
              delta: {},
              requires: {},
              annotator: null,
              enforced: false,
            },
            fallbackLine: null,
            unlisted: false,
            enforced: false,
            agents: [],
          },
          {
            toolId: "tool-battery",
            catalogId: serverId,
            catalogName: "GitHub",
            catalogIcon: null,
            prefix: "github",
            name: "get_commit",
            fullName: "github__get_commit",
            kind: "read",
            policySource: "battery",
            rule: {
              source: "battery",
              battery: "github",
              batteryEntry: "batteries/github/appa.toml",
              batteryStatus: "refused",
              line: 4,
              name: "mcp/github/get_commit",
              selector: null,
              delta: {},
              requires: {},
              annotator: null,
              enforced: false,
            },
            fallbackLine: null,
            unlisted: false,
            enforced: false,
            agents: [],
          },
          {
            toolId: "tool-fallback",
            catalogId: serverId,
            catalogName: "GitHub",
            catalogIcon: null,
            prefix: "github",
            name: "unlisted",
            fullName: "github__unlisted",
            kind: "unlisted",
            policySource: "fallback",
            rule: null,
            fallbackLine: null,
            unlisted: true,
            enforced: false,
            agents: [],
          },
        ],
        servers: [{ id: serverId, name: "GitHub", icon: null }],
        batteries: ["github"],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 3,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      }),
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ToolTable catalogId={serverId} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("get_commit")).toBeVisible();
  expect(screen.queryByRole("link", { name: /View source for/ })).toBeNull();
  expect(screen.getAllByText("Not enforced")).toHaveLength(2);
});

test("sorts by name, type, or tool count from the headers, kept in the URL", async () => {
  const push = vi.fn();
  vi.mocked(useRouter).mockReturnValue({
    push,
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(
      "entitiesSortBy=tools&entitiesSortDirection=asc&entitiesPage=2",
    ) as unknown as ReturnType<typeof useSearchParams>,
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <EntitiesTable />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Research gateway")).toBeVisible();
  expect(entityRequests[0]?.get("sortBy")).toBe("tools");
  expect(entityRequests[0]?.get("sortDirection")).toBe("asc");
  expect(
    screen.getByRole("columnheader", { name: "Tool coverage" }),
  ).toHaveAttribute("aria-sort", "ascending");
  expect(
    screen.getByRole("columnheader", { name: "Actions" }),
  ).not.toHaveAttribute("aria-sort");

  // Sorting again reverses it, and sorting another column starts ascending.
  await userEvent.click(screen.getByRole("button", { name: "Tool coverage" }));
  expect(push).toHaveBeenLastCalledWith(
    expect.stringContaining(
      "entitiesSortBy=tools&entitiesSortDirection=desc&entitiesPage=1",
    ),
    { scroll: false },
  );
  await userEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(push).toHaveBeenLastCalledWith(
    expect.stringContaining("entitiesSortBy=name&entitiesSortDirection=asc"),
    { scroll: false },
  );
});
