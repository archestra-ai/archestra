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
import { resolveOpenAppaLaunchPrompt } from "@/lib/openappa-chat-prompts";
import { makeSession, makeUserPermissions } from "@/mocks/data/auth";
import { RulesCard } from "./coverage-charts";

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

const CURRENT: Summary["composition"] = {
  kind: "current",
  servedRootRevision: 3,
  refusedRootRevision: null,
  rulesMayDiffer: false,
};

function renderCharts({
  summary,
  composition = CURRENT,
}: {
  summary: Totals;
  composition?: Summary["composition"];
}) {
  server.use(
    http.get(`${origin}/api/openappa/coverage/summary`, () =>
      HttpResponse.json({
        totals: summary,
        batteries: NO_BATTERIES,
        composition,
      }),
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RulesCard />
    </QueryClientProvider>,
  );
}

const card = (inside: HTMLElement) =>
  within(inside.closest('[data-slot="card"]') as HTMLElement);

test("splits every tool by what judges it, with the share a rule covers and a chat that fixes what runs unchecked", async () => {
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
    coverage.getByText("21 tools always run, with any data."),
  ).toBeVisible();

  // A legend row explains its slice and puts its share in the middle.
  await userEvent.hover(coverage.getByText("No rule"));
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "No rule21 tools, 53%Always allowed. Add rules to set limits.",
  );
  expect(coverage.getByText("no rule")).toBeVisible();
  expect(chatPrompt(coverage.getByRole("link", { name: "Fix in chat" }))).toBe(
    resolveOpenAppaLaunchPrompt("improveCoverage"),
  );
});

test("warns only while some tool runs with no rule", async () => {
  renderCharts({ summary: totals({ tools: 3, catchAll: 3 }) });

  expect(await screen.findByRole("img")).toBeVisible();
  expect(screen.queryByText("Low coverage.")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Fix in chat" }),
  ).not.toBeInTheDocument();
});

function chatPrompt(link: HTMLElement): string | null {
  return new URL(link.getAttribute("href") ?? "", origin).searchParams.get(
    "user_prompt",
  );
}

test("says so instead of charting while there is no tool", async () => {
  renderCharts({ summary: totals({}) });

  expect(await screen.findByText("No MCP server tools yet.")).toBeVisible();
  expect(screen.queryByText("covered")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Fix in chat" }),
  ).not.toBeInTheDocument();
});

test("names the earlier composition the chart describes while a refused revision keeps it enforced", async () => {
  renderCharts({
    summary: totals({ tools: 2, battery: 2 }),
    composition: {
      kind: "previous",
      servedRootRevision: 3,
      refusedRootRevision: 4,
      rulesMayDiffer: true,
    },
  });
  expect(
    await screen.findByTestId("coverage-composition-caption"),
  ).toHaveTextContent(
    "Showing revision 3, which the runtime still enforces; revision 4 was refused. The rules below are the current text's and may differ from what runs.",
  );
});

test("says nothing is enforced while only the root text alone is served", async () => {
  renderCharts({
    summary: totals({ tools: 2, notEnforced: 2 }),
    composition: {
      kind: "root_only",
      servedRootRevision: null,
      refusedRootRevision: 1,
      rulesMayDiffer: false,
    },
  });
  expect(
    await screen.findByTestId("coverage-composition-caption"),
  ).toHaveTextContent("Nothing is enforced");
});
