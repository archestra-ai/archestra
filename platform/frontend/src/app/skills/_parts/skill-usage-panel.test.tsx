import type { archestraApiTypes } from "@archestra/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillUsageStatistics } from "@/lib/skills/skill.query";
import { SkillUsagePanel } from "./skill-usage-panel";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/skills/skill.query", () => ({
  useSkillUsageStatistics: vi.fn(),
}));

// Recharts needs a real layout engine, so the chart stands in as plain nodes
// that still expose what each series was handed — which series exist, what
// colour each was given, and the per-day numbers they would draw.
vi.mock("recharts", () => ({
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Bar: ({ dataKey }: { dataKey: string }) => (
    <div data-testid="chart-bar" data-key={dataKey} />
  ),
  BarChart: ({
    children,
    data,
  }: {
    children: React.ReactNode;
    data?: Record<string, string | number>[];
  }) => (
    <div data-testid="chart-data" data-points={JSON.stringify(data ?? [])}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({
    config,
    children,
  }: {
    config: Record<string, { label: string; color: string }>;
    children: React.ReactNode;
  }) => (
    <div data-testid="chart" data-config={JSON.stringify(config)}>
      {children}
    </div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

type UsageStatistics =
  archestraApiTypes.GetSkillUsageStatisticsResponses["200"];
type UsageActor = UsageStatistics["users"][number];

const DAY_MS = 24 * 60 * 60 * 1000;

function renderPanel(stats: UsageStatistics | null, isPending = false) {
  vi.mocked(useSkillUsageStatistics).mockReturnValue({
    data: stats,
    isPending,
  } as unknown as ReturnType<typeof useSkillUsageStatistics>);
  return render(
    <SkillUsagePanel skillRef={{ kind: "standalone", skillId: "skill-1" }} />,
  );
}

function statistics(users: UsageActor[]): UsageStatistics {
  const today = new Date().toISOString().slice(0, 10);
  return {
    since: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    users,
    daily: users.map((user) => ({
      date: today,
      userId: user.userId,
      count: user.total,
    })),
  };
}

/** The per-actor breakdown, minus its header row. */
function breakdownRows() {
  const [, ...rows] = within(screen.getByRole("table")).getAllByRole("row");
  return rows;
}

/** The headline tile carrying `label`, value and caption together. */
function summaryTile(label: string) {
  const tile = screen.getByText(label).closest("div");
  if (!tile) throw new Error(`no summary tile for ${label}`);
  return tile;
}

/** A crowd of ordinary users, busiest first. */
function people(count: number, prefix = "user"): UsageActor[] {
  return Array.from({ length: count }, (_, index) => ({
    userId: `${prefix}-${index}`,
    name: `User ${index}`,
    kind: "user" as const,
    total: count - index,
  }));
}

describe("SkillUsagePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels each kind of actor distinctly instead of one shared unknown", () => {
    renderPanel(
      statistics([
        { userId: "user-1", name: "Ada Lovelace", kind: "user", total: 8 },
        {
          userId: "service-account:1",
          name: "Nightly sync",
          kind: "service_account",
          total: 4,
        },
        {
          userId: "service-account:2",
          name: null,
          kind: "service_account",
          total: 2,
        },
        { userId: "user-gone", name: null, kind: "user", total: 2 },
        { userId: null, name: null, kind: "unattributed", total: 1 },
      ]),
    );

    const labels = breakdownRows().map((row) => row.textContent);
    expect(labels[0]).toContain("Ada Lovelace");
    expect(labels[1]).toContain("Nightly sync");
    expect(labels[1]).toContain("service account");
    expect(labels[2]).toContain("Deleted service account");
    expect(labels[3]).toContain("Deleted user");
    expect(labels[4]).toContain("Unattributed");
  });

  it("gives every rendered series its own colour", () => {
    renderPanel(statistics(people(5)));

    const config: Record<string, { color: string }> = JSON.parse(
      screen.getByTestId("chart").dataset.config ?? "{}",
    );
    const colors = Object.values(config).map((entry) => entry.color);
    expect(colors).toHaveLength(5);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("folds actors past the colour ramp into one others series rather than dropping them", () => {
    renderPanel(statistics(people(8)));

    // The chart is bounded by the colour ramp, so its tail shares one series...
    const keys = screen
      .getAllByTestId("chart-bar")
      .map((bar) => bar.dataset.key);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(keys.length);

    // ...and the folded actors still reach it, so its bars keep summing to the
    // headline total rather than quietly losing the tail.
    const points: Record<string, number>[] = JSON.parse(
      screen.getByTestId("chart-data").dataset.points ?? "[]",
    );
    const charted = points.reduce(
      (sum, point) =>
        sum + keys.reduce((day, key) => day + Number(point[key ?? ""] ?? 0), 0),
      0,
    );
    expect(charted).toBe(36);
  });

  it("lists every actor in the breakdown, not only the ones the chart named", () => {
    renderPanel(statistics(people(8)));

    // The chart folds past five; the breakdown is where you go to find one
    // person among many, so it must not fold with it.
    expect(breakdownRows()).toHaveLength(8);
    expect(screen.getByText("User 7")).toBeInTheDocument();
  });

  it("filters the breakdown to the searched user", async () => {
    const user = userEvent.setup();
    renderPanel(
      statistics([
        { userId: "user-ada", name: "Ada Lovelace", kind: "user", total: 9 },
        { userId: "user-grace", name: "Grace Hopper", kind: "user", total: 8 },
        ...people(6, "filler"),
      ]),
    );

    await user.type(screen.getByRole("textbox"), "grace");

    await waitFor(() => expect(breakdownRows()).toHaveLength(1));
    expect(breakdownRows()[0].textContent).toContain("Grace Hopper");
  });

  it("sorts the breakdown by name when that column is chosen", async () => {
    const user = userEvent.setup();
    renderPanel(
      statistics([
        { userId: "user-1", name: "Zoe Zhang", kind: "user", total: 9 },
        { userId: "user-2", name: "Ada Lovelace", kind: "user", total: 2 },
      ]),
    );

    // Busiest-first by default, so the order is not already alphabetical.
    expect(breakdownRows()[0].textContent).toContain("Zoe Zhang");

    await user.click(screen.getByRole("button", { name: /sort by user/i }));

    await waitFor(() =>
      expect(breakdownRows()[0].textContent).toContain("Ada Lovelace"),
    );
  });

  it("counts attributed actors as users and leaves unattributed activations out", () => {
    renderPanel(
      statistics([
        { userId: "user-1", name: "Ada Lovelace", kind: "user", total: 3 },
        { userId: "user-2", name: "Grace Hopper", kind: "user", total: 2 },
        { userId: null, name: null, kind: "unattributed", total: 5 },
      ]),
    );

    expect(summaryTile("Activations")).toHaveTextContent("10");
    expect(summaryTile("Users")).toHaveTextContent("2");
  });

  it("shows an empty state when nothing was activated in the window", () => {
    renderPanel(statistics([]));

    expect(screen.getByText("No activations yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
