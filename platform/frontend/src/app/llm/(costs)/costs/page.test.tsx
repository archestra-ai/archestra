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
const mockUseUserStatistics = vi.fn();
const mockUseAppStatistics = vi.fn();
const mockUseSkillStatistics = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");

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
  useUserStatistics: (params: StatisticsHookParams) =>
    mockUseUserStatistics(params),
  useAppStatistics: (params: StatisticsHookParams) =>
    mockUseAppStatistics(params),
  useSkillStatistics: (params: StatisticsHookParams) =>
    mockUseSkillStatistics(params),
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
    mockUseUserStatistics.mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
    });
    mockUseAppStatistics.mockReturnValue({
      data: {
        data: [],
        pagination: { total: 0 },
        chatBaselineCostPerSession: 0,
        chatBaselineSessions: 0,
      },
    });
    mockUseSkillStatistics.mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
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

  it("shows each person's usage and model mix, and does not present subscription usage as spend", async () => {
    mockUseUserStatistics.mockReturnValue({
      data: {
        data: [
          {
            userId: "user-1",
            userName: "Dana Reyes",
            userEmail: "dana@example.com",
            requests: 42,
            inputTokens: 900,
            outputTokens: 100,
            cacheReadTokens: 0,
            totalTokens: 1000,
            // Entirely subscription-fulfilled: heavy usage, nothing billed.
            billedCost: 0,
            subscriptionCost: 12.5,
            activeDays: 4,
            lastActiveAt: "2026-07-27T10:00:00.000Z",
            models: [
              { model: "claude-sonnet-4", requests: 40 },
              { model: "gpt-5", requests: 2 },
            ],
          },
        ],
        pagination: { total: 1 },
      },
    });

    const { findByText, getByText } = render(<StatisticsPage />);

    expect(await findByText("Dana Reyes")).toBeInTheDocument();
    // Email is rendered so the row can be reconciled against an external roster.
    expect(getByText("dana@example.com")).toBeInTheDocument();
    expect(getByText("1,000")).toBeInTheDocument();
    expect(getByText("claude-sonnet-4")).toBeInTheDocument();
    // Usage is visible even though billed spend is $0.
    expect(getByText("Subscription")).toBeInTheDocument();
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

    // Teams, Agents, LLM Proxies, Models, People, Apps, Skills
    expect(tablePanels).toHaveLength(7);
    for (const tablePanel of tablePanels) {
      expect(tablePanel.className).toContain("max-h-[280px]");
      expect(tablePanel.className).toContain("overflow-auto");
    }
  });
  it("splits an app's build and runtime cost and discloses a shared build session", async () => {
    mockUseAppStatistics.mockReturnValue({
      data: {
        data: [
          {
            appId: "app-1",
            appName: "Sales Dashboard",
            authorName: "Dana Reyes",
            createdAt: "2026-07-20T10:00:00.000Z",
            buildRequests: 6,
            buildInputTokens: 20000,
            buildOutputTokens: 3000,
            buildCost: 1.5,
            // The same session built another app, so the build figure is shared.
            buildSessionAppCount: 2,
            hasBuildSession: true,
            runtimeLlmRequests: 4,
            runtimeInputTokens: 800,
            runtimeOutputTokens: 200,
            runtimeCost: 0.25,
            runs: 30,
            toolCalls: 90,
            estimatedChatEquivalentCost: 22.5,
            estimatedNetSavings: 20.75,
          },
        ],
        pagination: { total: 1 },
        chatBaselineCostPerSession: 0.75,
        chatBaselineSessions: 12,
      },
    });

    const { container, findByText, getByText } = render(<StatisticsPage />);

    expect(await findByText("Sales Dashboard")).toBeInTheDocument();
    // Build and runtime spend are reported separately: an app is not LLM-free
    // once built, so collapsing them would hide its recurring cost.
    expect(getByText("$1.50")).toBeInTheDocument();
    expect(getByText("$0.25")).toBeInTheDocument();
    expect(getByText("$20.75")).toBeInTheDocument();
    // The counterfactual states its own basis rather than being a bare number.
    // The sentence spans sibling elements, so it is asserted on the container.
    const appsDescription = Array.from(
      container.querySelectorAll('[data-slot="card-description"]'),
    ).find((node) => node.textContent?.includes("chat-equivalent estimate"));
    expect(appsDescription).toHaveTextContent(
      "measured average of $0.75 across 12 chat sessions",
    );
    // A shared build session is flagged, not silently divided.
    expect(getByText("$1.50").className).toContain("decoration-dotted");
  });

  it("reports no build cost for an app with no authoring session", async () => {
    mockUseAppStatistics.mockReturnValue({
      data: {
        data: [
          {
            appId: "app-2",
            appName: "Made In The UI",
            authorName: null,
            createdAt: "2026-07-20T10:00:00.000Z",
            buildRequests: 0,
            buildInputTokens: 0,
            buildOutputTokens: 0,
            buildCost: 0,
            buildSessionAppCount: 0,
            hasBuildSession: false,
            runtimeLlmRequests: 0,
            runtimeInputTokens: 0,
            runtimeOutputTokens: 0,
            runtimeCost: 0,
            runs: 2,
            toolCalls: 5,
            estimatedChatEquivalentCost: 1.5,
            estimatedNetSavings: 1.5,
          },
        ],
        pagination: { total: 1 },
        chatBaselineCostPerSession: 0.75,
        chatBaselineSessions: 12,
      },
    });

    const { findByText, getByText } = render(<StatisticsPage />);

    expect(await findByText("Made In The UI")).toBeInTheDocument();
    // An em dash, not $0.00: nothing was spent building it *that we know of*.
    expect(getByText("—")).toBeInTheDocument();
  });

  it("shows a skill's own context footprint next to the spend it rode", async () => {
    mockUseSkillStatistics.mockReturnValue({
      data: {
        data: [
          {
            skillId: "skill-1",
            skillName: "PDF Extraction",
            activations: 5,
            distinctUsers: 3,
            contextTokens: 6420,
            // Two older activations predate the measurement.
            measuredActivations: 3,
            attributedSessions: 4,
            attributedRequests: 12,
            attributedInputTokens: 90000,
            attributedOutputTokens: 7000,
            attributedCost: 1.68,
            lastActivatedAt: "2026-07-27T10:00:00.000Z",
          },
        ],
        pagination: { total: 1 },
      },
    });

    const { findByText, getByText } = render(<StatisticsPage />);

    expect(await findByText("PDF Extraction")).toBeInTheDocument();
    expect(getByText("6,420")).toBeInTheDocument();
    expect(getByText("$1.68")).toBeInTheDocument();
    // A partially-measured total is flagged rather than read as the full one.
    expect(getByText("6,420").className).toContain("decoration-dotted");
  });
});
