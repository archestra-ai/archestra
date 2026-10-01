import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { authClient } from "@/lib/clients/auth/auth-client";
import { makeSession, makeUserPermissions } from "@/mocks/data/auth";
import { CoverageCharts } from "./coverage-charts";

vi.mock("sonner");

const origin = "http://localhost:9000";
vi.mock("@/lib/clients/auth/auth-client");

const server = setupServer(
  http.get("http://localhost:9000/api/agents/all", () =>
    HttpResponse.json([
      {
        id: "appa-agent",
        name: "OpenAPPA Configuration Agent",
        scope: "org",
        builtIn: true,
        builtInAgentConfig: { name: "openappa-configuration-agent" },
        authorId: null,
        labels: [],
      },
    ]),
  ),
);
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
beforeEach(() => {
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: makeSession(),
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  server.use(
    http.get("http://localhost:9000/api/user/permissions", () =>
      HttpResponse.json(makeUserPermissions()),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

type Summary = archestraApiTypes.GetOpenappaCoverageSummaryResponses["200"];
type Totals = Summary["totals"];
type Batteries = Summary["batteries"];

const NO_BATTERIES: Batteries = { active: [], broken: [], available: [] };
const totals = (counts: Partial<Totals>): Totals => ({
  tools: 0,
  root: 0,
  battery: 0,
  notEnforced: 0,
  notCovered: 0,
  catchAll: 0,
  ...counts,
});

function renderCharts({
  summary,
  batteries = NO_BATTERIES,
  catalog = [],
}: {
  summary: Totals;
  batteries?: Batteries;
  /** The names of every battery package in the catalog. */
  catalog?: string[];
}) {
  server.use(
    http.get(`${origin}/api/openappa/coverage/summary`, () =>
      HttpResponse.json({ totals: summary, batteries }),
    ),
    http.get(`${origin}/api/openappa/batteries`, () =>
      HttpResponse.json(catalog.map((name) => ({ name }))),
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CoverageCharts />
    </QueryClientProvider>,
  );
}

const card = (inside: HTMLElement) =>
  within(inside.closest('[data-slot="card"]') as HTMLElement);

test("splits every tool by what judges it, with the share a rule covers and a chat that improves it", async () => {
  renderCharts({
    summary: totals({
      tools: 40,
      root: 4,
      battery: 6,
      notEnforced: 8,
      notCovered: 21,
      catchAll: 1,
    }),
  });

  const coverage = card(
    await screen.findByRole("img", {
      name: "Custom rule: 4, Battery rule: 6, Catch-all rule: 1, Not enforced: 8, No rule: 21",
    }),
  );
  expect(coverage.getByText("28%")).toBeVisible();
  const legend = [
    ["Custom rule", "4", "10%"],
    ["Battery rule", "6", "15%"],
    ["Not enforced", "8", "20%"],
    ["Catch-all rule", "1", "3%"],
    ["No rule", "21", "53%"],
  ];
  for (const [label, count, share] of legend) {
    const term = coverage.getByText(label as string);
    expect(term.nextElementSibling).toHaveTextContent(count as string);
    expect(term.nextElementSibling?.nextElementSibling).toHaveTextContent(
      share as string,
    );
  }

  expect(
    coverage.getByText(/53% of your tools can run without policy restrictions/),
  ).toBeVisible();

  // A legend row explains its slice and puts its share in the middle.
  await userEvent.hover(coverage.getByText("No rule"));
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "No rule21 tools, 53%Always allowed. Add rules to set limits.",
  );
  expect(coverage.getByText("no rule")).toBeVisible();
  expect(
    coverage.getByRole("link", { name: "Improve with chat" }),
  ).toHaveAttribute(
    "href",
    expect.stringContaining("user_prompt=Help+me+improve"),
  );
});

test("counts batteries by status, names them on hover, links each to its filter, and shows the coverage they would reach", async () => {
  renderCharts({
    summary: totals({
      tools: 40,
      battery: 6,
      catchAll: 4,
      notEnforced: 10,
      notCovered: 20,
    }),
    batteries: {
      active: [
        { name: "acme", tools: 4 },
        { name: "microsoft-learn", tools: 2 },
      ],
      broken: [{ name: "github", status: "missing_credentials", tools: 10 }],
      available: [
        { name: "atlassian", servers: ["Jira", "Confluence"], tools: 5 },
        { name: "posthog", servers: ["PostHog"], tools: 3 },
      ],
    },
    catalog: [
      "acme",
      "microsoft-learn",
      "github",
      "atlassian",
      "posthog",
      "slack",
      "linear",
    ],
  });

  const active = await screen.findByRole("link", { name: /^Active/ });
  const batteries = card(active);
  const tiles = [
    ["Active", "Active26 tools enforced", "active"],
    ["Broken", "Broken110 tools not enforced", "broken"],
    ["Available", "Available2+8 tools", "fits"],
  ];
  for (const [label, text, group] of tiles) {
    const tile = batteries.getByRole("link", {
      name: new RegExp(`^${label}`),
    });
    expect(tile).toHaveTextContent(text as string);
    expect(tile).toHaveAttribute("href", `/openappa/batteries?status=${group}`);
  }
  // Slack and Linear are in the catalog but fit no server.
  expect(
    await batteries.findByRole("link", { name: "2 more in catalog" }),
  ).toHaveAttribute("href", "/openappa/batteries?status=other");

  await userEvent.hover(batteries.getByRole("link", { name: /^Broken/ }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Broken batteriesGitHubneeds a credential",
  );

  // Catch-all coverage is included before adding the uncovered tools.
  expect(batteries.getByText("25% → 70%")).toBeVisible();
  expect(
    batteries.getByRole("img", {
      name: "Battery rule: 6, Catch-all rule: 4, Fixing broken batteries: 10, Installing available batteries: 8",
    }),
  ).toBeVisible();
  expect(
    batteries.getByRole("link", { name: "Configure with chat" }),
  ).toHaveAttribute(
    "href",
    expect.stringContaining("user_prompt=Help+me+configure"),
  );
});

test("offers no chat while every included battery is enforced and none fits", async () => {
  renderCharts({
    summary: totals({ tools: 4, battery: 4 }),
    batteries: {
      active: [{ name: "acme", tools: 4 }],
      broken: [],
      available: [],
    },
  });

  expect(
    await screen.findByText(
      "Every included battery is enforced, and no other battery fits your MCP servers.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Configure with chat" }),
  ).not.toBeInTheDocument();
});

test("shows no batteries card while no battery is included or fits", async () => {
  renderCharts({ summary: totals({ tools: 2, root: 2 }) });

  expect(
    await screen.findByRole("img", {
      name: "Custom rule: 2, Battery rule: 0, Catch-all rule: 0, Not enforced: 0, No rule: 0",
    }),
  ).toBeVisible();
  expect(screen.queryByText("Batteries")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    await screen.findByRole("link", { name: "Improve with chat" }),
  ).toBeVisible();
});

test.each([
  {
    counts: { notCovered: 3, catchAll: 0 },
    visible:
      "100% of your tools can run without policy restrictions. Add rules to control what your agents can do.",
    absent:
      "100% of your tools share one catch-all rule. Add specific rules to set limits for individual tools.",
  },
  {
    counts: { notCovered: 0, catchAll: 3 },
    visible:
      "100% of your tools share one catch-all rule. Add specific rules to set limits for individual tools.",
    absent:
      "100% of your tools can run without policy restrictions. Add rules to control what your agents can do.",
  },
])("shows the relevant warning without buttons and keeps one chat action", async (scenario) => {
  renderCharts({ summary: totals({ tools: 3, ...scenario.counts }) });
  expect(await screen.findByText(scenario.visible)).toBeVisible();
  expect(screen.queryByText(scenario.absent)).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(scenario.visible);
  expect(
    within(screen.getByRole("alert")).queryByRole("button"),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("alert")).queryByRole("link"),
  ).not.toBeInTheDocument();
  const chat = await screen.findByRole("link", { name: "Improve with chat" });
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(
    new URL(chat.getAttribute("href") ?? "", origin).searchParams.get(
      "user_prompt",
    ),
  ).toContain("tools covered by a non-noop catch-all");
});

test("says so instead of charting while there is no tool", async () => {
  renderCharts({ summary: totals({}) });

  expect(await screen.findByText("No MCP server tools yet.")).toBeVisible();
  expect(screen.queryByText("covered")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Improve with chat" }),
  ).not.toBeInTheDocument();
});
