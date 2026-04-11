import type { StatisticsTimeFrame } from "@shared";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StatisticsPage from "./page";

const mockRouterPush = vi.fn();
let mockSearchParams = new URLSearchParams();
const mockSetCostsAction = vi.fn();

const mockUseTeamStatistics = vi.fn();
const mockUseProfileStatistics = vi.fn();
const mockUseModelStatistics = vi.fn();
const mockUseCostSavingsStatistics = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/app/llm/(costs)/layout", () => ({
  useSetCostsAction: () => mockSetCostsAction,
}));

vi.mock("@/lib/statistics.query", () => ({
  useTeamStatistics: (params: { timeframe: StatisticsTimeFrame }) =>
    mockUseTeamStatistics(params),
  useProfileStatistics: (params: { timeframe: StatisticsTimeFrame }) =>
    mockUseProfileStatistics(params),
  useModelStatistics: (params: { timeframe: StatisticsTimeFrame }) =>
    mockUseModelStatistics(params),
  useCostSavingsStatistics: (params: { timeframe: StatisticsTimeFrame }) =>
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
      });
    });

    expect(mockUseProfileStatistics).toHaveBeenLastCalledWith({
      timeframe: customTimeframe,
    });
    expect(mockUseModelStatistics).toHaveBeenLastCalledWith({
      timeframe: customTimeframe,
    });
    expect(mockUseCostSavingsStatistics).toHaveBeenLastCalledWith({
      timeframe: customTimeframe,
    });
    expect(
      mockUseTeamStatistics.mock.calls.some(
        ([params]) => params.timeframe === "all",
      ),
    ).toBe(false);
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
