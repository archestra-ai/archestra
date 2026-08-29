import type { StatisticsTimeFrame } from "@archestra/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrganizationCostsPage from "./page";

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

describe("OrganizationCostsPage", () => {
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

  it("holds the layout with placeholders instead of reporting zeros before the numbers arrive", async () => {
    // Every statistics request still in flight — the state the page is in on
    // its very first paint.
    for (const hook of [
      mockUseTeamStatistics,
      mockUseProfileStatistics,
      mockUseModelStatistics,
      mockUseCostSavingsStatistics,
      mockUseUserStatistics,
      mockUseAppStatistics,
      mockUseSkillStatistics,
    ]) {
      hook.mockReturnValue({ data: undefined, isPending: true });
    }

    const { container } = render(<OrganizationCostsPage />);

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-slot="skeleton"]').length,
      ).toBeGreaterThan(0);
    });

    // A loading page must not answer questions it cannot answer yet: "$0.00"
    // and "No data available" are claims about the organization, not about the
    // request.
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("No data available")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No team data available for the selected timeframe"),
    ).not.toBeInTheDocument();

    // The tiles keep their labels so the page reads as itself while it loads.
    expect(
      screen.getByText("Metered usage charged at API rates"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Teams").length).toBeGreaterThan(0);
  });

  it("shows the organization-wide analytics", async () => {
    render(<OrganizationCostsPage />);

    await waitFor(() => {
      expect(screen.getAllByText("People").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Teams").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("my-usage-summary")).not.toBeInTheDocument();
  });

  it("summarizes billed, subscription-covered, request, and token totals", () => {
    mockUseCostSavingsStatistics.mockReturnValue({
      data: {
        totalBaselineCost: 12,
        totalActualCost: 8.25,
        totalSavings: 3.75,
        totalSubscriptionCost: 14.5,
        totalToonSavings: 2,
        totalCacheSavings: 1.75,
        timeSeries: [],
      },
    });
    mockUseModelStatistics.mockReturnValue({
      data: [
        {
          model: "example/model-a",
          requests: 10,
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 4_000,
          cost: 8.25,
          percentage: 100,
          timeSeries: [],
        },
      ],
    });

    render(<OrganizationCostsPage />);

    expect(screen.getAllByText("$8.25")).not.toHaveLength(0);
    expect(screen.getByText("$14.50")).toBeInTheDocument();
    expect(screen.getByText("5,200")).toBeInTheDocument();
    expect(
      screen.getByText("Metered usage charged at API rates"),
    ).toBeInTheDocument();
    expect(screen.getByText("List-price value not billed")).toBeInTheDocument();
  });

  it("queries statistics with the selected custom timeframe", async () => {
    const customTimeframe =
      "custom:2026-07-01T00:00:00.000Z_2026-07-31T23:59:59.999Z";
    mockSearchParams = new URLSearchParams([["timeframe", customTimeframe]]);

    render(<OrganizationCostsPage />);

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

    render(<OrganizationCostsPage />);

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
            userName: "Example User A",
            userEmail: "user-a@example.test",
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

    const { findByText, getByText } = render(<OrganizationCostsPage />);

    expect(await findByText("Example User A")).toBeInTheDocument();
    // Email is rendered so the row can be reconciled against an external roster.
    expect(getByText("user-a@example.test")).toBeInTheDocument();
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

    const { findByText } = render(<OrganizationCostsPage />);

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

    const { findAllByTestId } = render(<OrganizationCostsPage />);

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
            userName: "Example User B",
            userEmail: "user-b@example.test",
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

    const { findByText, queryByText } = render(<OrganizationCostsPage />);

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
            userName: "Example User C",
            userEmail: "user-c@example.test",
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

    const { findByText, container } = render(<OrganizationCostsPage />);
    await findByText("Example User C");

    // `table-fixed` splits width equally without explicit widths, which left
    // the Models and Cost columns narrower than their badges — the badges then
    // overflowed onto the neighbouring column. The same floor is on every
    // statistics table so phone viewports scroll instead of wrapping cells.
    const peopleTable = Array.from(
      container.querySelectorAll("table.min-w-\\[70rem\\]"),
    ).find((table) => table.textContent?.includes("Example User C"));
    expect(peopleTable).toBeDefined();

    const headers = Array.from(peopleTable?.querySelectorAll("thead th") ?? []);
    expect(headers).toHaveLength(7);
    for (const header of headers) {
      expect(header.className).toMatch(/w-\[\d+%\]/);
      expect(header.className).toMatch(/min-w-\[/);
      expect(header.className).toMatch(/max-w-\[/);
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

    const { getAllByTestId } = render(<OrganizationCostsPage />);

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

    const { container } = render(<OrganizationCostsPage />);

    const tablePanels = Array.from(
      container.querySelectorAll(".max-h-\\[280px\\]"),
    );

    // Teams, Agents, Models, People, Apps, Skills. The LLM Proxy has no
    // table: it is one entity, so the card reports totals instead.
    expect(tablePanels).toHaveLength(6);
    for (const tablePanel of tablePanels) {
      expect(tablePanel.className).toContain("max-h-[280px]");
      expect(tablePanel.className).toContain("overflow-auto");
      const table = tablePanel.querySelector("table.min-w-\\[70rem\\]");
      expect(table).not.toBeNull();
      expect(table?.className).toContain("table-auto");
    }
  });
  it("reports LLM Proxy usage as one total rather than a table of proxies", () => {
    // The organization has a single LLM Proxy, so whatever proxy-attributed
    // rows come back are one entity's usage — including a deployment holding
    // more than one organization, which is what these two rows stand in for.
    mockUseProfileStatistics.mockReturnValue({
      data: [
        {
          agentId: "proxy-1",
          agentName: "LLM Proxy",
          teamName: "No Team",
          agentType: "llm_proxy",
          requests: 1200,
          inputTokens: 900,
          outputTokens: 100,
          cacheReadTokens: 0,
          cost: 12.5,
          timeSeries: [{ timestamp: "2026-08-11T00:00:00.000Z", value: 12.5 }],
        },
        {
          agentId: "proxy-2",
          agentName: "LLM Proxy",
          teamName: "No Team",
          agentType: "llm_proxy",
          requests: 34,
          inputTokens: 40,
          outputTokens: 60,
          cacheReadTokens: 0,
          cost: 0.25,
          timeSeries: [{ timestamp: "2026-08-11T00:00:00.000Z", value: 0.25 }],
        },
      ],
    });

    const { getAllByTestId } = render(<OrganizationCostsPage />);

    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("1,100")).toBeInTheDocument();
    expect(screen.getByText("$12.75")).toBeInTheDocument();

    // One series keyed by the data field, and the buckets the rows share are
    // summed rather than repeated — a duplicate timestamp would render as
    // whichever point the chart reached first.
    const chart = getAllByTestId("chart").find((el) =>
      (el.getAttribute("data-config") ?? "").includes('"cost"'),
    );
    expect(chart).toBeDefined();
    const lines = Array.from(
      chart?.querySelectorAll("[data-testid='chart-line']") ?? [],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute("data-key")).toBe("cost");
  });

  it("splits an app's build and runtime cost and discloses a shared build session", async () => {
    mockUseAppStatistics.mockReturnValue({
      data: {
        data: [
          {
            appId: "app-1",
            appName: "Sales Dashboard",
            authorName: "Example User A",
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

    const { container, findByText, getByText } = render(
      <OrganizationCostsPage />,
    );

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

    const { findByText, getByText } = render(<OrganizationCostsPage />);

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

    const { findByText, getByText } = render(<OrganizationCostsPage />);

    expect(await findByText("PDF Extraction")).toBeInTheDocument();
    expect(getByText("6,420")).toBeInTheDocument();
    expect(getByText("$1.68")).toBeInTheDocument();
    // A partially-measured total is flagged rather than read as the full one.
    expect(getByText("6,420").className).toContain("decoration-dotted");
  });
});
