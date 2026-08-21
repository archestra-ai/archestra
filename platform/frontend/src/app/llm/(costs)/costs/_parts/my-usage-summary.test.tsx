import type { archestraApiTypes } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMyStatistics } from "@/lib/statistics.query";
import { MyUsageSummary } from "./my-usage-summary";

vi.mock("@/lib/statistics.query", () => ({
  useMyStatistics: vi.fn(),
}));

vi.mock("recharts", () => ({
  Area: ({ dataKey }: { dataKey: string }) => (
    <div data-testid="chart-area" data-key={dataKey} />
  ),
  AreaChart: ({
    children,
    data,
  }: {
    children: React.ReactNode;
    data?: { label?: string }[];
  }) => (
    <div>
      <span data-testid="chart-points">{(data ?? []).length}</span>
      {children}
    </div>
  ),
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="chart">{children}</div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

type MyStatistics = archestraApiTypes.GetMyStatisticsResponses["200"];

const baseStats: MyStatistics = {
  requests: 12,
  inputTokens: 800,
  outputTokens: 200,
  cacheReadTokens: 50,
  totalTokens: 1000,
  billedCost: 1.5,
  subscriptionCost: 0,
  activeDays: 3,
  lastActiveAt: "2026-08-20T10:30:00.000Z",
  models: [],
  timeSeries: [],
};

const mockStats = (
  stats: MyStatistics | undefined,
  { isPending = false, isLoadingError = false } = {},
) => {
  vi.mocked(useMyStatistics).mockReturnValue({
    data: stats,
    isPending,
    isLoadingError,
  } as unknown as ReturnType<typeof useMyStatistics>);
};

describe("MyUsageSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the caller's own headline figures", () => {
    mockStats({
      ...baseStats,
      requests: 187,
      totalTokens: 472_756,
      activeDays: 27,
    });

    render(<MyUsageSummary timeframe="30d" />);

    expect(screen.getByText("187")).toBeInTheDocument();
    expect(screen.getByText("472,756")).toBeInTheDocument();
    expect(screen.getByText("27")).toBeInTheDocument();
  });

  it("does not present subscription-covered usage as money spent", () => {
    mockStats({ ...baseStats, billedCost: 2, subscriptionCost: 40 });

    render(<MyUsageSummary timeframe="30d" />);

    // The billed figure stands alone, flagged as partly subscription-covered;
    // the $42 list price is never shown as spend.
    expect(screen.getByText("$2.0000")).toBeInTheDocument();
    expect(screen.getByText("Subscription")).toBeInTheDocument();
    expect(screen.queryByText("$42.0000")).not.toBeInTheDocument();
  });

  it("says so plainly when the timeframe holds no activity", () => {
    mockStats({ ...baseStats, requests: 0, totalTokens: 0, billedCost: 0 });

    render(<MyUsageSummary timeframe="30d" />);

    expect(
      screen.getByText(/no recorded activity for the selected timeframe/i),
    ).toBeInTheDocument();
  });

  it("does not report a failed request as a quiet timeframe", () => {
    mockStats(undefined, { isLoadingError: true });

    render(<MyUsageSummary timeframe="30d" />);

    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/no recorded activity/i)).not.toBeInTheDocument();
  });

  it("collapses the model mix past the badge limit rather than overflowing", () => {
    mockStats({
      ...baseStats,
      models: ["a", "b", "c", "d", "e"].map((model) => ({
        model,
        requests: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        billedCost: 0.1,
        subscriptionCost: 0,
      })),
    });

    render(<MyUsageSummary timeframe="30d" />);

    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.queryByText("d")).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("holds the request until the page has resolved its timeframe", () => {
    mockStats(undefined, { isPending: true });

    render(<MyUsageSummary timeframe="30d" enabled={false} />);

    expect(useMyStatistics).toHaveBeenCalledWith({
      timeframe: "30d",
      enabled: false,
    });
  });

  it("draws the spend trend only once there is a trend to draw", () => {
    mockStats({
      ...baseStats,
      timeSeries: [{ timestamp: "2026-08-20T10:00:00.000Z", value: 1 }],
    });
    const { rerender } = render(<MyUsageSummary timeframe="30d" />);
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();

    mockStats({
      ...baseStats,
      timeSeries: [
        { timestamp: "2026-08-20T10:00:00.000Z", value: 1 },
        { timestamp: "2026-08-20T11:00:00.000Z", value: 2 },
      ],
    });
    rerender(<MyUsageSummary timeframe="30d" />);
    expect(screen.getByTestId("chart-points")).toHaveTextContent("2");
  });
});
