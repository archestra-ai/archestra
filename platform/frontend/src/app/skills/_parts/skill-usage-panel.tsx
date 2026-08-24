"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { ArrowDown, ArrowUp, ChartNoAxesColumn } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import {
  type SkillUsageReference,
  useSkillUsageStatistics,
} from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";

type UsageStatistics =
  archestraApiTypes.GetSkillUsageStatisticsResponses["200"];
type UsageActor = UsageStatistics["users"][number];

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Distinct series the chart can draw, bounded by the theme's `--chart-N` ramp.
 * Actors past this rank are folded into one neutral "others" series rather than
 * wrapping back to `--chart-1`, which used to give two people the same colour
 * and make a stacked bar unreadable. The fold is the *chart's* limit only — the
 * breakdown below it still lists every actor, so nobody is hidden by it.
 */
const MAX_NAMED_SERIES = 5;
const OTHERS_KEY = "others";
/** A window is a month or so; anything wider is a bad `since`, not a window. */
const MAX_WINDOW_DAYS = 120;
const DEFAULT_WINDOW_DAYS = 30;
/** Past this many actors the breakdown is worth searching rather than scanning. */
const SEARCHABLE_FROM = 8;

/**
 * Per-skill usage analytics: headline totals, a stacked per-actor bar chart of
 * daily activations across the reported window, and a searchable per-actor
 * breakdown.
 *
 * Rendered both as the skill page's Usage tab and, for a skill served by an
 * MCP server (which has no page of its own), inside `SkillUsageDialog`.
 */
export function SkillUsagePanel({
  skillRef,
  enabled = true,
}: {
  skillRef: SkillUsageReference;
  /** Lets the dialog hold the request back until it is actually opened. */
  enabled?: boolean;
}) {
  const { data: stats, isPending } = useSkillUsageStatistics(
    enabled ? skillRef : null,
  );

  const { series, actors, chartConfig, chartData, summary } = useMemo(
    () => buildUsageModel(stats ?? null),
    [stats],
  );

  if (isPending) return <UsageSkeleton />;

  if (summary.totalUses === 0) {
    return (
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
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-1 divide-y rounded-lg border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
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
                  summary.busiestDay.count === 1 ? "activation" : "activations"
                }`
              : undefined
          }
        />
      </dl>

      <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
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

      <ActorBreakdown actors={actors} totalUses={summary.totalUses} />
    </div>
  );
}

/**
 * Every actor that ran the skill, as a table that can be searched and sorted.
 *
 * The chart above can only draw as many colours as the theme ramp has, so it
 * folds its tail into one "others" series. This does not: a skill used by forty
 * people is a list of forty rows, and the only way to answer "how often did
 * *this* person run it" is to search for them.
 */
function ActorBreakdown({
  actors,
  totalUses,
}: {
  actors: UsageRow[];
  totalUses: number;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "total", dir: "desc" });
  const searchable = actors.length >= SEARCHABLE_FROM;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? actors.filter((actor) => actor.search.includes(needle))
      : actors;
    const direction = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) =>
      sort.key === "name"
        ? direction * a.label.localeCompare(b.label)
        : direction * (a.total - b.total),
    );
  }, [actors, query, sort]);

  const toggle = (key: SortState["key"]) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : // Names read A–Z first, counts read biggest-first: the useful default
          // differs per column, so a fresh column does not inherit the other's.
          { key, dir: key === "name" ? "asc" : "desc" },
    );

  return (
    <section
      aria-labelledby="skill-usage-actors"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="skill-usage-actors" className="text-sm font-semibold">
          Activations by user
          <span className="ml-2 font-normal text-muted-foreground tabular-nums">
            {query.trim()
              ? `${rows.length} of ${actors.length}`
              : actors.length.toLocaleString()}
          </span>
        </h3>
        {searchable && (
          <SearchInput
            placeholder="Search users..."
            className="w-full sm:w-64"
            syncQueryParams={false}
            value={query}
            debounceMs={150}
            onSearchChange={setQuery}
          />
        )}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No users match “{query.trim()}”.
        </p>
      ) : (
        // Long lists scroll inside the section rather than pushing the chart
        // off the top of the page. The height caps `Table`'s own container
        // rather than a wrapper around it: that container already sets
        // `overflow-x`, which makes it the scroll box on both axes, and a
        // sticky header inside it only sticks to the box that actually
        // scrolls. Capping a parent instead left the header behind on the
        // first scroll, which is when 40 rows most need their columns named.
        <div className="rounded-lg border [&_[data-slot=table-container]]:max-h-[26rem] [&_[data-slot=table-container]]:overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="w-auto">
                  <SortButton
                    label="User"
                    active={sort.key === "name"}
                    dir={sort.dir}
                    onClick={() => toggle("name")}
                  />
                </TableHead>
                <TableHead className="hidden w-40 sm:table-cell">
                  Share
                </TableHead>
                <TableHead className="w-32 text-right">
                  <SortButton
                    label="Uses"
                    align="right"
                    active={sort.key === "total"}
                    dir={sort.dir}
                    onClick={() => toggle("total")}
                  />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((actor) => (
                <TableRow key={actor.id}>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: actor.color }}
                      />
                      <TruncatedTooltip content={actor.label}>
                        <span className="min-w-0 truncate">{actor.label}</span>
                      </TruncatedTooltip>
                      {actor.badge ? (
                        <Badge
                          variant="outline"
                          className="shrink-0 font-normal text-muted-foreground"
                        >
                          {actor.badge}
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div
                      aria-hidden
                      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${shareBarWidth(actor.total, totalUses)}%`,
                          backgroundColor: actor.color,
                        }}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {actor.total.toLocaleString()}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {formatShare(actor.total, totalUses)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function SortButton({
  label,
  active,
  dir,
  align = "left",
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortState["dir"];
  align?: "left" | "right";
  onClick: () => void;
}) {
  const Icon = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      // The sort state belongs on the header cell for assistive tech, but this
      // button is what carries the click, so it also says which way it points.
      aria-label={`Sort by ${label.toLowerCase()}, currently ${
        active ? (dir === "asc" ? "ascending" : "descending") : "unsorted"
      }`}
      className={cn(
        "flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        align === "right" && "ml-auto",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {label}
      <Icon
        aria-hidden
        className={cn("size-3.5", active ? "opacity-100" : "opacity-0")}
      />
    </button>
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
      <Skeleton className="h-64 w-full" />
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

type SortState = { key: "name" | "total"; dir: "asc" | "desc" };

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

/** One row of the breakdown: every actor, whether or not the chart named it. */
type UsageRow = {
  /** Stable row key; the id is nullable, so its rank stands in when it is null. */
  id: string;
  label: string;
  badge: string | null;
  color: string;
  total: number;
  /** Pre-lowercased haystack, so filtering does not rebuild it per keystroke. */
  search: string;
};

/**
 * Turns the API payload into everything the panel renders. Series keys are
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
      color: OTHERS_COLOR,
      total: rest.reduce((sum, actor) => sum + actor.total, 0),
    });
  }

  // Every actor gets a row, and its colour is the one the chart drew it in —
  // a ramp colour for the five it named, the neutral "others" colour for the
  // rest — so a row can be traced back to a band in the bars above it.
  const rows: UsageRow[] = actors.map((actor, index) => {
    const described = describeActor(actor);
    return {
      id: actor.userId ?? `rank-${index}`,
      ...described,
      color:
        index < MAX_NAMED_SERIES ? `var(--chart-${index + 1})` : OTHERS_COLOR,
      total: actor.total,
      search: `${described.label} ${described.badge ?? ""}`.toLowerCase(),
    };
  });

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
    actors: rows,
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

const OTHERS_COLOR = "var(--muted-foreground)";

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
 * How wide the reported window is, in the two senses the panel needs.
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

/** The window the panel's own copy describes, for callers that echo it. */
export const SKILL_USAGE_WINDOW_FALLBACK_DAYS = DEFAULT_WINDOW_DAYS;
