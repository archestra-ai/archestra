import type { StatisticsTimeFrame } from "@archestra/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
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
const mockUseMyStatistics = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/auth/auth.query");

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
  useMyStatistics: (params: StatisticsHookParams) =>
    mockUseMyStatistics(params),
}));

vi.mock("recharts", () => ({
  CartesianGrid: () => null,
  // Expose what each series was given so tests can check the chart wiring
  // without rendering SVG.
  Line: ({ dataKey, stroke }: { dataKey: string; stroke: string }) => (
    <div data-testid="chart-line" data-key={dataKey} data-stroke={stroke} />
  ),
  // The x-axis is a category axis keyed off each point's `label`, so surfacing
  // the labels is enough to see what the rendered axis would read.
  LineChart: ({
    children,
    data,
  }: {
    children: React.ReactNode;
    data?: { label?: string }[];
  }) => (
    <div>
      <span data-testid="chart-axis-labels">
        {(data ?? []).map((point) => point.label).join("|")}
      </span>
      {children}
    </div>
  ),
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({
    config,
    children,
  }: {
    config: Record<string, { label: string }>;
    children: React.ReactNode;
  }) => (
    <div data-testid="chart" data-config={JSON.stringify(config)}>
      {children}
    </div>
  ),
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

vi.mock("@/components/ui/custom-date-time-range-dialog", () => ({
  CustomDateTimeRangeDialog: () => null,
}));

/** Grants or denies `llmCost:read`, which decides what the page renders. */
const setCanReadOrganizationCosts = (canRead: boolean) => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: canRead,
  } as unknown as ReturnType<typeof useHasPermissions>);
};

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
    mockUseMyStatistics.mockReturnValue({
      data: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        billedCost: 0,
        subscriptionCost: 0,
        activeDays: 0,
        lastActiveAt: null,
        models: [],
        timeSeries: [],
      },
      isPending: false,
    });
    setCanReadOrganizationCosts(true);
  });

  it("keeps the personal summary for a caller who cannot read organization-wide costs", async () => {
    setCanReadOrganizationCosts(false);

    render(<StatisticsPage />);

    // The whole reason the page is reachable without `llmCost:read`.
    await waitFor(() => {
      expect(screen.getByTestId("my-usage-summary")).toBeInTheDocument();
    });
    // ...and nothing that reports on anyone else.
    expect(screen.queryAllByText("People")).toHaveLength(0);
    expect(screen.queryAllByText("Teams")).toHaveLength(0);
    expect(screen.queryAllByText("Cost Savings")).toHaveLength(0);
  });

  it("does not request organization-wide statistics it may not read", async () => {
    setCanReadOrganizationCosts(false);

    render(<StatisticsPage />);

    await waitFor(() => {
      expect(mockUseMyStatistics).toHaveBeenCalled();
    });

    // Those endpoints would answer 403, so the queries stay disabled rather
    // than firing a round of requests whose only outcome is a rejection.
    for (const hook of [
      mockUseTeamStatistics,
      mockUseProfileStatistics,
      mockUseModelStatistics,
      mockUseCostSavingsStatistics,
      mockUseUserStatistics,
      mockUseAppStatistics,
      mockUseSkillStatistics,
    ]) {
      expect(
        hook.mock.calls.every(([params]) => params.enabled === false),
      ).toBe(true);
    }
  });

  it("shows the organization-wide charts alongside the summary when permitted", async () => {
    render(<StatisticsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("my-usage-summary")).toBeInTheDocument();
    });
    expect(screen.getAllByText("People").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Teams").length).toBeGreaterThan(0);
  });

  it("asks for the caller's own usage on the same timeframe as the rest of the page", async () => {
    mockSearchParams = new URLSearchParams([["timeframe", "7d"]]);

    render(<StatisticsPage />);

    await waitFor(() => {
      expect(mockUseMyStatistics).toHaveBeenLastCalledWith({
        timeframe: "7d",
        enabled: true,
      });
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

  it("still renders when the custom timeframe in the URL is malformed", async () => {
    // Well-formed enough for the schema, but the bounds are not dates — the
    // selector label must not try to format an Invalid Date.
    mockSearchParams = new URLSearchParams([
      ["timeframe", "custom:not-a-date_also-not-a-date"],
    ]);

    const { findByText } = render(<StatisticsPage />);

    expect(await findByText("Cost Savings")).toBeInTheDocument();
  });

  it("labels each bucket of a multi-day chart distinctly", async () => {
    mockSearchParams = new URLSearchParams([["timeframe", "7d"]]);
    // A 7d chart aggregates into 6-hour buckets, so a single day supplies four
    // consecutive points that a day-only label would collapse into one tick.
    mockUseCostSavingsStatistics.mockReturnValue({
      data: {
        timeSeries: [
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T06:00:00.000Z",
          "2026-07-01T12:00:00.000Z",
          "2026-07-01T18:00:00.000Z",
          "2026-07-02T00:00:00.000Z",
        ].map((timestamp) => ({
          timestamp,
          baselineCost: 2,
          actualCost: 1,
          toonSavings: 0,
          cacheSavings: 0,
          subscriptionCost: 0,
        })),
      },
    });

    const { findAllByTestId } = render(<StatisticsPage />);

    const [axis] = await findAllByTestId("chart-axis-labels");
    const labels = (axis.textContent ?? "").split("|");

    expect(labels).toHaveLength(5);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("shows a metered person's cost as money, not a savings percentage", async () => {
    mockUseUserStatistics.mockReturnValue({
      data: {
        data: [
          {
            userId: "user-2",
            userName: "Joey Orlando",
            userEmail: "joey@example.com",
            requests: 15260,
            inputTokens: 19000000,
            outputTokens: 572756,
            cacheReadTokens: 0,
            totalTokens: 19572756,
            // Pay-as-you-go: everything is billed, nothing subscription-covered.
            billedCost: 41.4405,
            subscriptionCost: 0,
            activeDays: 8,
            lastActiveAt: "2026-08-11T14:41:00.000Z",
            models: [{ model: "anthropic/claude-opus-4.8", requests: 15260 }],
          },
        ],
        pagination: { total: 1 },
      },
    });

    const { findByText, queryByText } = render(<StatisticsPage />);

    // The Cost column must read as spend. It rendered the savings percentage
    // ("0%") for everyone without subscription usage while `tooltip` was left
    // at its "never" default.
    expect(await findByText("$41.4405")).toBeInTheDocument();
    expect(queryByText("0%")).not.toBeInTheDocument();
  });

  it("reserves width for the People columns that carry badges", async () => {
    mockUseUserStatistics.mockReturnValue({
      data: {
        data: [
          {
            userId: "user-3",
            userName: "Ildar Iskhakov",
            userEmail: "ildar@example.com",
            requests: 118,
            inputTokens: 3000000,
            outputTokens: 883994,
            cacheReadTokens: 0,
            totalTokens: 3883994,
            billedCost: 1.5,
            subscriptionCost: 0,
            activeDays: 6,
            lastActiveAt: "2026-08-11T14:38:00.000Z",
            models: [{ model: "anthropic/claude-opus-4.8", requests: 118 }],
          },
        ],
        pagination: { total: 1 },
      },
    });

    const { findByText, container } = render(<StatisticsPage />);
    await findByText("Ildar Iskhakov");

    // `table-fixed` splits width equally without explicit widths, which left
    // the Models and Cost columns narrower than their badges — the badges then
    // overflowed onto the neighbouring column.
    const peopleTable = container.querySelector("table.min-w-\\[900px\\]");
    expect(peopleTable).not.toBeNull();

    const headers = Array.from(peopleTable?.querySelectorAll("thead th") ?? []);
    expect(headers).toHaveLength(7);
    for (const header of headers) {
      expect(header.className).toMatch(/w-\[\d+%\]/);
    }
  });

  it("charts the five costliest models under CSS-safe series keys", () => {
    // Six models, deliberately NOT in cost order: the API returns entities in
    // first-seen order, and the chart used to slice that order while claiming
    // "top 5 by cost".
    const model = (name: string, cost: number) => ({
      model: name,
      requests: 1,
      inputTokens: 10,
      outputTokens: 5,
      cost,
      percentage: 0,
      timeSeries: [{ timestamp: "2026-08-11T00:00:00.000Z", value: cost }],
    });
    mockUseModelStatistics.mockReturnValue({
      data: [
        model("google/gemini-3-pro-preview", 0.1),
        model("anthropic/claude-opus-4.8", 46),
        model("moonshotai/kimi-k2-thinking", 0.64),
        model("openrouter/auto", 4.21),
        model("deepseek/deepseek-v3.1-terminus", 5),
        model("z-ai/glm-4.6", 1.64),
      ],
    });

    const { getAllByTestId } = render(<StatisticsPage />);

    // The Models chart is the one whose config labels are model ids.
    const chart = getAllByTestId("chart").find((el) =>
      (el.getAttribute("data-config") ?? "").includes("claude-opus-4.8"),
    );
    expect(chart).toBeDefined();
    const config = JSON.parse(chart?.getAttribute("data-config") ?? "{}");

    // Top 5 by cost, costliest first — gemini ($0.10) must be the one left out.
    expect(
      Object.values(config).map((c) => (c as { label: string }).label),
    ).toEqual([
      "anthropic/claude-opus-4.8",
      "deepseek/deepseek-v3.1-terminus",
      "openrouter/auto",
      "z-ai/glm-4.6",
      "moonshotai/kimi-k2-thinking",
    ]);

    // Series keys become CSS custom-property names (`--color-<key>`). Model
    // ids contain `/` and `.`, which are not valid there, so keying by the raw
    // id gave every line an unresolvable stroke and no colour anywhere.
    const lines = Array.from(
      chart?.querySelectorAll("[data-testid='chart-line']") ?? [],
    );
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      const key = line.getAttribute("data-key") ?? "";
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(config[key]).toBeDefined();
      expect(line.getAttribute("data-stroke")).toBe(`var(--color-${key})`);
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
