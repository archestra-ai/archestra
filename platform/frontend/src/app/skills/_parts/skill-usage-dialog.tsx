"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { ChartNoAxesColumn } from "lucide-react";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import {
  type SkillUsageReference,
  useSkillUsageStatistics,
} from "@/lib/skills/skill.query";

type UsageStatistics =
  archestraApiTypes.GetSkillUsageStatisticsResponses["200"];
type UsageActor = UsageStatistics["users"][number];

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Distinct series the chart can draw, bounded by the theme's `--chart-N` ramp.
 * Actors past this rank are folded into one neutral "others" series rather than
 * wrapping back to `--chart-1`, which used to give two people the same colour
 * and make a stacked bar unreadable.
 */
const MAX_NAMED_SERIES = 5;
const OTHERS_KEY = "others";
/** A window is a month or so; anything wider is a bad `since`, not a window. */
const MAX_WINDOW_DAYS = 120;
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Per-skill usage analytics: headline totals, a stacked per-actor bar chart of
 * daily activations across the reported window, and a per-actor breakdown.
 */
export function SkillUsageDialog({
  skillRef,
  skillName,
  open,
  onOpenChange,
}: {
  skillRef: SkillUsageReference;
  skillName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: stats, isPending } = useSkillUsageStatistics(
    open ? skillRef : null,
  );

  const { series, chartConfig, chartData, summary } = useMemo(
    () => buildUsageModel(stats ?? null),
    [stats],
  );

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-3xl"
      title={`Usage of "${skillName}"`}
      description={`Who activated this skill over the last ${summary.windowDays} days, and how often.`}
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
        <UsageSkeleton />
      ) : summary.totalUses === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ChartNoAxesColumn />
            </EmptyMedia>
            <EmptyTitle>No activations yet</EmptyTitle>
            <EmptyDescription>
              {`This skill has not been activated in the last ${summary.windowDays} days.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          <dl className="grid grid-cols-3 divide-x rounded-lg border">
            <SummaryStat
              label={summary.totalUses === 1 ? "Activation" : "Activations"}
              value={summary.totalUses.toLocaleString()}
            />
            <SummaryStat
              label={summary.actorCount === 1 ? "User" : "Users"}
              value={summary.actorCount.toLocaleString()}
            />
            <SummaryStat
              label="Busiest day"
              value={summary.busiestDay?.label ?? "—"}
              hint={
                summary.busiestDay
                  ? `${summary.busiestDay.count.toLocaleString()} ${
                      summary.busiestDay.count === 1
                        ? "activation"
                        : "activations"
                    }`
                  : undefined
              }
            />
          </dl>

          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-56 w-full"
          >
            <BarChart
              accessibilityLayer
              data={chartData}
              margin={{ top: 12, left: 0, right: 8 }}
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
                tickMargin={4}
                width={32}
                allowDecimals={false}
              />
              <ChartTooltip
                cursor={{ fill: "var(--muted)", fillOpacity: 0.6 }}
                content={<UsageTooltip />}
              />
              {series.map((entry) => (
                <Bar
                  key={entry.key}
                  dataKey={entry.key}
                  stackId="uses"
                  fill={`var(--color-${entry.key})`}
                  isAnimationActive={false}
                  // Only the topmost series is rounded, so a stack reads as one
                  // bar with a cap rather than a column of separate beads.
                  radius={2}
                />
              ))}
            </BarChart>
          </ChartContainer>

          <ul
            aria-label="Activations by user"
            className="flex flex-col gap-2.5"
          >
            {series.map((entry) => (
              <li key={entry.key} className="flex items-center gap-3 text-sm">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: entry.color }}
                />
                <TruncatedTooltip content={entry.label}>
                  <span className="min-w-0 flex-1 truncate text-left">
                    {entry.label}
                  </span>
                </TruncatedTooltip>
                {entry.badge ? (
                  <Badge
                    variant="outline"
                    className="shrink-0 font-normal text-muted-foreground"
                  >
                    {entry.badge}
                  </Badge>
                ) : null}
                <div
                  aria-hidden
                  className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${shareBarWidth(entry.total, summary.totalUses)}%`,
                      backgroundColor: entry.color,
                    }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right tabular-nums">
                  {entry.total.toLocaleString()}{" "}
                  {entry.total === 1 ? "use" : "uses"}
                </span>
                <span className="w-11 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {formatShare(entry.total, summary.totalUses)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </StandardDialog>
  );
}

function SummaryStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  // Column-reverse so the term still precedes its definition in the DOM (what
  // a screen reader pairs up) while the number reads first on screen.
  return (
    <div className="flex flex-col-reverse px-4 py-3">
      <dt className="mt-0.5 truncate text-xs text-muted-foreground">
        {hint ? `${label} · ${hint}` : label}
      </dt>
      <dd className="truncate text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-[74px] w-full" />
      <Skeleton className="h-56 w-full" />
      <div className="flex flex-col gap-2.5">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-5 w-full" />
        ))}
      </div>
    </div>
  );
}

/**
 * The shared tooltip, minus the series that did not happen on the hovered day.
 * A stacked chart hands every series to the tooltip, so without this an idle
 * day lists every actor at 0 and buries the one or two that are non-zero.
 */
function UsageTooltip(props: React.ComponentProps<typeof ChartTooltipContent>) {
  const payload = (props.payload ?? []).filter(
    (item) => Number(item.value) > 0,
  );
  if (payload.length === 0) return null;

  const dayTotal = payload.reduce((sum, item) => sum + Number(item.value), 0);
  const fullLabel = (payload[0]?.payload as ChartDatum | undefined)?.fullLabel;

  return (
    <ChartTooltipContent
      {...props}
      payload={payload}
      className="max-w-72"
      labelFormatter={(label) => (
        <div className="flex items-baseline justify-between gap-4">
          <span>{fullLabel ?? label}</span>
          <span className="font-normal text-muted-foreground tabular-nums">
            {dayTotal} {dayTotal === 1 ? "use" : "uses"}
          </span>
        </div>
      )}
    />
  );
}

// === internal ===

type ChartDatum = {
  label: string;
  fullLabel: string;
  [seriesKey: string]: string | number;
};

type UsageSeries = {
  key: string;
  label: string;
  /** Set when the actor is not an ordinary person, e.g. a service account. */
  badge: string | null;
  color: string;
  total: number;
};

/**
 * Turns the API payload into everything the dialog renders. Series keys are
 * synthetic (`u0`, `u1`, ...) because ChartContainer turns config keys into CSS
 * variable names, and raw user ids may contain characters that break them.
 */
function buildUsageModel(stats: UsageStatistics | null) {
  const actors = stats?.users ?? [];
  const named = actors.slice(0, MAX_NAMED_SERIES);
  const rest = actors.slice(MAX_NAMED_SERIES);

  const series: UsageSeries[] = named.map((actor, index) => ({
    key: `u${index}`,
    ...describeActor(actor),
    color: `var(--chart-${index + 1})`,
    total: actor.total,
  }));
  if (rest.length > 0) {
    series.push({
      key: OTHERS_KEY,
      label: `${rest.length} ${rest.length === 1 ? "other" : "others"}`,
      badge: null,
      color: "var(--muted-foreground)",
      total: rest.reduce((sum, actor) => sum + actor.total, 0),
    });
  }

  const chartConfig: ChartConfig = Object.fromEntries(
    series.map((entry) => [
      entry.key,
      { label: entry.label, color: entry.color },
    ]),
  );

  // Every actor maps to a series so the bars always sum to the totals below
  // them: the ones past the colour ramp land in the shared "others" series
  // instead of being dropped from the chart.
  const keyByUserId = new Map<string | null, string>([
    ...named.map(
      (actor, index) => [actor.userId, `u${index}`] as [string | null, string],
    ),
    ...rest.map(
      (actor) => [actor.userId, OTHERS_KEY] as [string | null, string],
    ),
  ]);

  const countsByDay = new Map<string, Record<string, number>>();
  for (const bucket of stats?.daily ?? []) {
    const key = keyByUserId.get(bucket.userId);
    if (!key) continue;
    const day = countsByDay.get(bucket.date) ?? {};
    day[key] = (day[key] ?? 0) + bucket.count;
    countsByDay.set(bucket.date, day);
  }

  // Continuous UTC-day axis so quiet days render as gaps, not missing ticks.
  // The span comes from the window the API reports rather than a constant, so
  // every bucket it returns has a bar to land in and the chart adds up to the
  // totals beside it.
  const { axisDays, windowDays } = describeWindow(stats?.since);
  const todayUtc = new Date().toISOString().slice(0, 10);
  const start =
    new Date(`${todayUtc}T00:00:00Z`).getTime() - (axisDays - 1) * DAY_MS;
  const chartData: ChartDatum[] = Array.from(
    { length: axisDays },
    (_, index) => {
      const date = new Date(start + index * DAY_MS);
      const isoDay = date.toISOString().slice(0, 10);
      return {
        label: date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
        fullLabel: date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }),
        ...Object.fromEntries(series.map((entry) => [entry.key, 0])),
        ...countsByDay.get(isoDay),
      };
    },
  );

  const totalUses = actors.reduce((sum, actor) => sum + actor.total, 0);
  const busiest = chartData.reduce<{ label: string; count: number } | null>(
    (best, datum) => {
      const count = series.reduce(
        (sum, entry) => sum + Number(datum[entry.key] ?? 0),
        0,
      );
      return count > (best?.count ?? 0) ? { label: datum.label, count } : best;
    },
    null,
  );

  return {
    series,
    chartConfig,
    chartData,
    summary: {
      totalUses,
      // Matches the "by N users" count on the skills table, which likewise
      // counts distinct attributed ids and ignores unattributed activations.
      actorCount: actors.filter((actor) => actor.userId !== null).length,
      busiestDay: busiest,
      windowDays,
    },
  };
}

function describeActor(actor: UsageActor): {
  label: string;
  badge: string | null;
} {
  if (actor.kind === "unattributed") {
    return { label: "Unattributed", badge: "no signed-in user" };
  }
  if (actor.kind === "service_account") {
    return {
      label: actor.name ?? "Deleted service account",
      badge: actor.name ? "service account" : null,
    };
  }
  return { label: actor.name ?? "Deleted user", badge: null };
}

/**
 * How wide the reported window is, in the two senses the dialog needs.
 *
 * `windowDays` is its length — what the copy calls "the last N days". `axisDays`
 * is how many UTC calendar days it touches, which is one more whenever the
 * window does not start at midnight: a 30-day window opened at 16:00 reaches
 * back into a 31st day, and events recorded in that tail need a bar to land in
 * or the chart stops adding up to the totals printed beside it.
 */
function describeWindow(since: string | undefined): {
  axisDays: number;
  windowDays: number;
} {
  const start = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(start)) {
    return { axisDays: DEFAULT_WINDOW_DAYS, windowDays: DEFAULT_WINDOW_DAYS };
  }
  const clamp = (days: number) => Math.min(Math.max(days, 1), MAX_WINDOW_DAYS);
  const startOfDay = (time: number) =>
    Date.parse(`${new Date(time).toISOString().slice(0, 10)}T00:00:00Z`);
  return {
    axisDays: clamp(
      Math.round((startOfDay(Date.now()) - startOfDay(start)) / DAY_MS) + 1,
    ),
    windowDays: clamp(Math.round((Date.now() - start) / DAY_MS)),
  };
}

/** Keeps a non-zero share visible as a sliver rather than an empty track. */
function shareBarWidth(total: number, overall: number): number {
  if (overall <= 0) return 0;
  return Math.max((total / overall) * 100, 3);
}

function formatShare(total: number, overall: number): string {
  if (overall <= 0) return "0%";
  const share = (total / overall) * 100;
  return share < 1 ? "<1%" : `${Math.round(share)}%`;
}
