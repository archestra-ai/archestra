"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { useSkillUsageStatistics } from "@/lib/skills/skill.query";

const WINDOW_DAYS = 30;
const CHART_COLOR_COUNT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-skill usage analytics: a stacked per-user bar chart of daily activations
 * over the last month, plus per-user totals.
 */
export function SkillUsageDialog({
  skillId,
  skillName,
  open,
  onOpenChange,
}: {
  skillId: string;
  skillName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: stats, isPending } = useSkillUsageStatistics(
    open ? skillId : null,
  );

  // Users become chart series. Series keys are synthetic (`u0`, `u1`, ...)
  // because ChartContainer turns config keys into CSS variable names, and raw
  // user ids may contain characters that break them.
  const { users, chartConfig, chartData, totalUses } = useMemo(() => {
    const users = (stats?.users ?? []).map((user, index) => ({
      ...user,
      key: `u${index}`,
      label: user.name ?? "Unknown user",
      color: `var(--chart-${(index % CHART_COLOR_COUNT) + 1})`,
    }));

    const chartConfig: ChartConfig = Object.fromEntries(
      users.map((user) => [user.key, { label: user.label, color: user.color }]),
    );

    const keyByUserId = new Map(users.map((user) => [user.userId, user.key]));
    const countsByDay = new Map<string, Record<string, number>>();
    for (const bucket of stats?.daily ?? []) {
      const key = keyByUserId.get(bucket.userId);
      if (!key) continue;
      const day = countsByDay.get(bucket.date) ?? {};
      day[key] = (day[key] ?? 0) + bucket.count;
      countsByDay.set(bucket.date, day);
    }

    // Continuous UTC-day axis so quiet days render as gaps, not missing ticks.
    const todayUtc = new Date().toISOString().slice(0, 10);
    const start =
      new Date(`${todayUtc}T00:00:00Z`).getTime() - (WINDOW_DAYS - 1) * DAY_MS;
    const chartData = Array.from({ length: WINDOW_DAYS }, (_, i) => {
      const date = new Date(start + i * DAY_MS);
      const isoDay = date.toISOString().slice(0, 10);
      return {
        label: date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
        ...Object.fromEntries(users.map((user) => [user.key, 0])),
        ...countsByDay.get(isoDay),
      };
    });

    const totalUses = users.reduce((sum, user) => sum + user.total, 0);
    return { users, chartConfig, chartData, totalUses };
  }, [stats]);

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Usage of "${skillName}"`}
      description={`Who activated this skill over the last ${WINDOW_DAYS} days, and how often.`}
      footer={
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      }
    >
      {isPending ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          Loading usage...
        </div>
      ) : totalUses === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No uses in the last {WINDOW_DAYS} days.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-64 w-full"
          >
            <BarChart
              accessibilityLayer
              data={chartData}
              margin={{ top: 12, left: 12, right: 12 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                allowDecimals={false}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              {users.map((user) => (
                <Bar
                  key={user.key}
                  dataKey={user.key}
                  stackId="uses"
                  fill={`var(--color-${user.key})`}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ChartContainer>

          <ul className="space-y-1">
            {users.map((user) => (
              <li key={user.key} className="flex items-center gap-2 text-sm">
                <span
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: user.color }}
                />
                <span className="min-w-0 flex-1 truncate">{user.label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {user.total} {user.total === 1 ? "use" : "uses"}
                </span>
              </li>
            ))}
            <li className="flex items-center gap-2 border-t pt-1.5 text-sm font-medium">
              <span className="size-2.5 shrink-0" />
              <span className="min-w-0 flex-1">Total</span>
              <span className="tabular-nums">
                {totalUses} {totalUses === 1 ? "use" : "uses"}
              </span>
            </li>
          </ul>
        </div>
      )}
    </StandardDialog>
  );
}
