import type { archestraApiTypes } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillUsageStatistics } from "@/lib/skills/skill.query";
import { SkillUsageDialog } from "./skill-usage-dialog";

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

function renderDialog(stats: UsageStatistics | null, isPending = false) {
  vi.mocked(useSkillUsageStatistics).mockReturnValue({
    data: stats,
    isPending,
  } as unknown as ReturnType<typeof useSkillUsageStatistics>);
  return render(
    <SkillUsageDialog
      skillId="skill-1"
      skillName="jira-task"
      open
      onOpenChange={vi.fn()}
    />,
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

function seriesRows() {
  // The per-actor breakdown is the only list in the dialog.
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

/** The headline tile carrying `label`, value and caption together. */
function summaryTile(label: string) {
  const tile = screen.getByText(label).closest("div");
  if (!tile) throw new Error(`no summary tile for ${label}`);
  return tile;
}

describe("SkillUsageDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels each kind of actor distinctly instead of one shared unknown", () => {
    renderDialog(
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

    const labels = seriesRows().map((row) => row.textContent);
    expect(labels[0]).toContain("Ada Lovelace");
    expect(labels[1]).toContain("Nightly sync");
    expect(labels[1]).toContain("service account");
    expect(labels[2]).toContain("Deleted service account");
    expect(labels[3]).toContain("Deleted user");
    expect(labels[4]).toContain("Unattributed");
  });

  it("gives every rendered series its own colour", () => {
    renderDialog(
      statistics(
        Array.from({ length: 5 }, (_, index) => ({
          userId: `user-${index}`,
          name: `User ${index}`,
          kind: "user" as const,
          total: 10 - index,
        })),
      ),
    );

    const config: Record<string, { color: string }> = JSON.parse(
      screen.getByTestId("chart").dataset.config ?? "{}",
    );
    const colors = Object.values(config).map((entry) => entry.color);
    expect(colors).toHaveLength(5);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("folds actors past the colour ramp into one others series rather than dropping them", () => {
    renderDialog(
      statistics(
        Array.from({ length: 8 }, (_, index) => ({
          userId: `user-${index}`,
          name: `User ${index}`,
          kind: "user" as const,
          total: 10 - index,
        })),
      ),
    );

    const rows = seriesRows();
    expect(rows).toHaveLength(6);
    expect(rows[5].textContent).toContain("3 others");
    // 10+9+8+7+6 named, 5+4+3 folded together
    expect(rows[5].textContent).toContain("12 uses");

    // and the folded actors still reach the chart, so its bars keep summing to
    // the headline total rather than quietly losing the tail
    const keys = screen
      .getAllByTestId("chart-bar")
      .map((bar) => bar.dataset.key);
    expect(new Set(keys).size).toBe(keys.length);
    const points: Record<string, number>[] = JSON.parse(
      screen.getByTestId("chart-data").dataset.points ?? "[]",
    );
    const charted = points.reduce(
      (sum, point) =>
        sum + keys.reduce((day, key) => day + Number(point[key ?? ""] ?? 0), 0),
      0,
    );
    expect(charted).toBe(52);
  });

  it("counts attributed actors as users and leaves unattributed activations out", () => {
    renderDialog(
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
    renderDialog(statistics([]));

    expect(screen.getByText("No activations yet")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
