import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import CostExplorer from "./cost-explorer";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/config.query")>()),
  useFeature: () => false,
}));
vi.mock("@/lib/proxy-label-costs.query", () => ({
  useProxyLabelKeys: () => ({ data: [] }),
}));
vi.mock("./cost-explorer.query", () => ({
  useCostsTimeRange: () => ({ timeframe: "30d", enabled: true }),
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
  vi.mocked(useAppName).mockReturnValue("Test platform");
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});

it("opens Limits with the selected model and clears only the context when selection is cleared", () => {
  render(<CostExplorer />);
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
  render(<CostExplorer />);
  expect(
    screen.queryByRole("link", { name: /limits/ }),
  ).not.toBeInTheDocument();
});

it("distinguishes API and billed spend from subscription estimates and explains token reporting", () => {
  render(<CostExplorer />);
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
