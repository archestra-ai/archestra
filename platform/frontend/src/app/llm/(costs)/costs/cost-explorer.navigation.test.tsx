import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import CostExplorer from "./cost-explorer";
import { useCostsTimeRange } from "./cost-explorer.query";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/config.query")>()),
  useFeature: () => false,
}));
vi.mock("./cost-explorer.query", () => ({
  useCostsTimeRange: vi.fn(),
  useCostStatistics: () => ({
    data: { costSavings: { totalSubscriptionCost: 0, totalActualCost: 2 } },
  }),
  useKpis: () => ({
    billed: { value: 2, series: [1, 1] },
    subscription: { value: 0, series: [0, 0] },
    requests: { value: 2, series: [1, 1] },
    tokens: { value: 200, series: [100, 100] },
    people: { value: 1 },
    isCostPending: false,
    isUsagePending: false,
    isPeoplePending: false,
  }),
  formatCost: (n: number) => `$${n.toFixed(2)}`,
  formatCompact: (n: number) => String(n),
  formatInt: (n: number) => String(n),
}));
vi.mock("./cost-explorer-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cost-explorer-data")>()),
  usePivotCube: () => ({
    rows: [
      {
        key: "vendor/model-1",
        label: "Demo model",
        total: 2,
        series: [1, 1],
        children: [],
        extras: {},
        hasSeries: true,
      },
    ],
    total: 2,
    buckets: ["2026-01-01", "2026-01-02"],
    splitKeys: [],
    extraCols: [],
    api: "GET /api/statistics/models",
    isLoading: false,
    error: undefined,
  }),
}));
vi.mock("./cost-explorer-parts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cost-explorer-parts")>()),
  PivotChart: () => null,
}));

beforeEach(() => {
  vi.mocked(useCostsTimeRange).mockReturnValue({
    timeframe: "30d",
    enabled: true,
  });
  vi.mocked(useAppName).mockReturnValue("Test platform");
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});

it("opens Limits with the selected model and clears only the context when selection is cleared", () => {
  renderExplorer();
  expect(
    screen.getByRole("link", { name: "Show spend limits" }),
  ).toHaveAttribute("href", "/llm/limits?units=token_cost");
  fireEvent.click(screen.getByText("Demo model", { selector: "td span" }));
  expect(
    screen.getByRole("link", { name: "Show spend limits for Demo model" }),
  ).toHaveAttribute(
    "href",
    "/llm/limits?units=token_cost&model=vendor%2Fmodel-1",
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(
    screen.getByRole("link", { name: "Show spend limits" }),
  ).toHaveAttribute("href", "/llm/limits?units=token_cost");
});

it("does not offer a Limits action without llmLimit read permission", () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: !("llmLimit" in permissions),
      }) as ReturnType<typeof useHasPermissions>,
  );
  renderExplorer();
  expect(
    screen.queryByRole("link", { name: /limits/ }),
  ).not.toBeInTheDocument();
});

it("distinguishes API and billed spend from subscription estimates and explains token reporting", () => {
  renderExplorer();
  expect(screen.getByText("API spend")).toBeInTheDocument();
  expect(screen.getByText("Subscription usage estimate")).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("button", { name: "Show Billed spend" }), {
    key: "Enter",
  });
  fireEvent.click(screen.getByRole("menuitem", { name: /^Tokens$/ }));
  expect(screen.getByText(/Counts newly processed input/)).toHaveTextContent(
    "Reused cached input is shown separately and is not included.",
  );
});

it("shows no selected label when the window contains no captured labels", async () => {
  server.use(
    http.get(`${origin}/api/statistics/llm-proxy`, () =>
      HttpResponse.json({ labelKeys: [] }),
    ),
  );
  const { client } = renderExplorer();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "View Spend by model" }),
    {
      key: "Enter",
    },
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Spend by label" }));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await waitFor(() =>
    expect(
      screen.queryByRole("combobox", { name: "Label key" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByText("cost_center")).not.toBeInTheDocument();
});

it("selects only keys returned for the window and resets invalid selections on range changes", async () => {
  server.use(
    http.get(`${origin}/api/statistics/llm-proxy`, ({ request }) => {
      const timeframe = new URL(request.url).searchParams.get("timeframe");
      const labelKeys =
        timeframe === "30d" || timeframe === "90d"
          ? ["application", "department"]
          : timeframe === "7d"
            ? ["project"]
            : [];
      return HttpResponse.json({ labelKeys });
    }),
  );
  const { rerenderExplorer, client } = renderExplorer();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "View Spend by model" }),
    {
      key: "Enter",
    },
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Spend by label" }));
  await screen.findByRole("combobox", { name: "Label key" });
  const select = () => screen.getByRole("combobox", { name: "Label key" });
  await waitFor(() => expect(select()).toHaveTextContent("application"));
  fireEvent.click(select());
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(["application", "department"]);
  fireEvent.click(screen.getByRole("option", { name: "department" }));
  expect(select()).toHaveTextContent("department");

  vi.mocked(useCostsTimeRange).mockReturnValue({
    timeframe: "90d",
    enabled: true,
  });
  rerenderExplorer();
  await waitFor(() => expect(select()).toHaveTextContent("department"));

  vi.mocked(useCostsTimeRange).mockReturnValue({
    timeframe: "7d",
    enabled: true,
  });
  rerenderExplorer();
  expect(screen.queryByText("department")).not.toBeInTheDocument();
  await waitFor(() => expect(select()).toHaveTextContent("project"));
  fireEvent.click(select());
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(["project"]);
  fireEvent.click(screen.getByRole("option", { name: "project" }));

  vi.mocked(useCostsTimeRange).mockReturnValue({
    timeframe: "24h",
    enabled: true,
  });
  rerenderExplorer();
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await waitFor(() =>
    expect(
      screen.queryByRole("combobox", { name: "Label key" }),
    ).not.toBeInTheDocument(),
  );

  vi.mocked(useCostsTimeRange).mockReturnValue({
    timeframe: "30d",
    enabled: true,
  });
  rerenderExplorer();
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Label key" }),
    ).toHaveTextContent("application"),
  );
});

it("offers retry after label discovery fails and discovers keys on recovery", async () => {
  let available = false;
  server.use(
    http.get(`${origin}/api/statistics/llm-proxy`, () =>
      available
        ? HttpResponse.json({ labelKeys: ["department"] })
        : HttpResponse.json(
            { error: { message: "Temporarily unavailable" } },
            { status: 503 },
          ),
    ),
  );
  renderExplorer();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "View Spend by model" }),
    { key: "Enter" },
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Spend by label" }));
  expect(
    await screen.findByText("Could not load usage statistics"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Label key" }),
  ).not.toBeInTheDocument();
  available = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Label key" }),
    ).toHaveTextContent("department"),
  );
  expect(
    screen.queryByText("Could not load usage statistics"),
  ).not.toBeInTheDocument();
});

const origin = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderExplorer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const content = () => (
    <QueryClientProvider client={client}>
      <CostExplorer />
    </QueryClientProvider>
  );
  const { rerender } = render(content());
  return { client, rerenderExplorer: () => rerender(content()) };
}
