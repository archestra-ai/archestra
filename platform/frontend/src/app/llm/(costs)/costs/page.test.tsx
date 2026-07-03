import type { StatisticsTimeFrame } from "@archestra/shared";
import { render, waitFor } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StatisticsPage from "./page";

const mockRouterPush = vi.fn();
let mockSearchParams = new URLSearchParams();
const mockSetCostsAction = vi.fn();

const mockUseTeamStatistics = vi.fn();
const mockUseProfileStatistics = vi.fn();
const mockUseModelStatistics = vi.fn();
const mockUseCostSavingsStatistics = vi.fn();

vi.mock("next/navigation");

vi.mock("@/app/llm/(costs)/layout", () => ({
  useSetCostsAction: () => mockSetCostsAction,
}));

type StatisticsHookParams = {
  timeframe: StatisticsTimeFrame;
  enabled?: boolean;
};

vi.mock("@/lib/statistics.query", () => ({
  useTeamStatistics: (params: StatisticsHookParams) =>
    mockUseTeamStatistics(params),
  useProfileStatistics: (params: StatisticsHookParams) =>
    mockUseProfileStatistics(params),
  useModelStatistics: (params: StatisticsHookParams) =>
    mockUseModelStatistics(params),
  useCostSavingsStatistics: (params: StatisticsHookParams) =>
    mockUseCostSavingsStatistics(params),
}));

vi.mock("recharts", () => ({
  CartesianGrid: () => null,
  Line: () => null,
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

vi.mock("@/components/ui/custom-date-time-range-dialog", () => ({
  CustomDateTimeRangeDialog: () => null,
}));

describe("StatisticsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockImplementation(
      () => mockSearchParams as unknown as ReturnType<typeof useSearchParams>,
    );
    mockSearchParams = new URLSearchParams();
    mockUseTeamStatistics.mockReturnValue({ data: [] });
    mockUseProfileStatistics.mockReturnValue({ data: [] });
    mockUseModelStatistics.mockReturnValue({ data: [] });
    mockUseCostSavingsStatistics.mockReturnValue({
      data: { timeSeries: [] },
    });
  });

  it("queries statistics with the selected custom timeframe", async () => {
    const customTimeframe =
      "custom:2026-07-01T00:00:00.000Z_2026-07-31T23:59:59.999Z";
    mockSearchParams = new URLSearchParams([["timeframe", customTimeframe]]);

    render(<StatisticsPage />);

    await waitFor(() => {
      expect(mockUseTeamStatistics).toHaveBeenLastCalledWith({
        timeframe: customTimeframe,
        enabled: true,
      });
    });

    expect(mockUseProfileStatistics).toHaveBeenLastCalledWith({
      timeframe: customTimeframe,
      enabled: true,
    });
    expect(mockUseModelStatistics).toHaveBeenLastCalledWith({
      timeframe: customTimeframe,
      enabled: true,
    });
    expect(mockUseCostSavingsStatistics).toHaveBeenLastCalledWith({
      timeframe: customTimeframe,
      enabled: true,
    });
    expect(
      mockUseTeamStatistics.mock.calls.some(
        ([params]) => params.timeframe === "all",
      ),
    ).toBe(false);
  });

  it("never enables the queries for the default timeframe when a persisted one exists", async () => {
    localStorage.setItem("cost-statistics-timeframe", "30d");

    render(<StatisticsPage />);

    await waitFor(() => {
      expect(mockUseTeamStatistics).toHaveBeenLastCalledWith({
        timeframe: "30d",
        enabled: true,
      });
    });

    // A page load must not fire a throwaway round of default-timeframe
    // requests before the persisted timeframe is resolved.
    for (const hook of [
      mockUseTeamStatistics,
      mockUseProfileStatistics,
      mockUseModelStatistics,
      mockUseCostSavingsStatistics,
    ]) {
      expect(
        hook.mock.calls.some(
          ([params]) => params.enabled && params.timeframe !== "30d",
        ),
      ).toBe(false);
    }
  });

  it("renders statistics tables inside capped scroll containers", () => {
    mockUseTeamStatistics.mockReturnValue({
      data: [
        {
          teamId: "team-1",
          teamName: "Platform",
          members: 3,
          agents: 2,
          requests: 12,
          inputTokens: 100,
          outputTokens: 50,
          cost: 42,
          timeSeries: [],
        },
      ],
    });
    mockUseProfileStatistics.mockReturnValue({
      data: [
        {
          agentId: "agent-1",
          agentName: "My Assistant",
          teamName: "Platform",
          agentType: "agent",
          requests: 9,
          inputTokens: 80,
          outputTokens: 20,
          cost: 15,
          timeSeries: [],
        },
        {
          agentId: "proxy-1",
          agentName: "Default Proxy",
          teamName: "Platform",
          agentType: "llm_proxy",
          requests: 4,
          inputTokens: 20,
          outputTokens: 10,
          cost: 5,
          timeSeries: [],
        },
      ],
    });
    mockUseModelStatistics.mockReturnValue({
      data: [
        {
          model: "gpt-5",
          requests: 7,
          inputTokens: 70,
          outputTokens: 30,
          cost: 9,
          percentage: 100,
          timeSeries: [],
        },
      ],
    });

    const { container } = render(<StatisticsPage />);

    const tablePanels = Array.from(
      container.querySelectorAll(".max-h-\\[280px\\]"),
    );

    expect(tablePanels).toHaveLength(4);
    for (const tablePanel of tablePanels) {
      expect(tablePanel.className).toContain("max-h-[280px]");
      expect(tablePanel.className).toContain("overflow-auto");
    }
  });
});
