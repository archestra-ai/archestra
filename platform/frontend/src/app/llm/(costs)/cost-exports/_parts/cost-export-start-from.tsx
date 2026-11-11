"use client";

import {
  type CostExportSchedule,
  getStatisticsBucketIntervalMinutes,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import { useEffect, useMemo, useState } from "react";
import {
  type ChartDay,
  CostChart,
  presetDate,
  StartPresetPicker,
} from "@/app/llm/models/_parts/model-cost-chart";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useCostSavingsStatistics } from "@/lib/statistics.query";
import { cn } from "@/lib/utils/tailwind";
import { startFromConsequence } from "./start-from-consequence";

/**
 * "Start from" on a new cost export: now, a past date (a backfill, picked on
 * the organization's daily spend), or all recorded usage. Reports the start
 * through `onChange`; null is now.
 */
export function CostExportStartFrom({
  id,
  schedule,
  onChange,
}: {
  /** Prefix for element ids. */
  id: string;
  schedule: CostExportSchedule;
  onChange: (startFrom: Date | null) => void;
}) {
  const [mode, setMode] = useState<StartMode>("now");
  const [sinceDate, setSinceDate] = useState<Date>(() =>
    presetDate(DEFAULT_PRESET_MS),
  );
  const [presetId, setPresetId] = useState<string | null>(DEFAULT_PRESET_ID);
  // The chart's range: grows to show an older start, so the handle sits at
  // the real date instead of the left edge. Dragging never changes it.
  const [scale, setScale] = useState<ChartScale>(scaleFor(sinceDate));

  // Daily buckets for the last 30 days; monthly ones back to the first use.
  const recent = useCostSavingsStatistics({ timeframe: "30d" });
  const history = useCostSavingsStatistics({ timeframe: "all" });
  const chart = useCostSavingsStatistics({
    timeframe: SCALES[scale].timeframe,
    enabled: mode === "date",
  });
  const firstUsage = useMemo(
    () =>
      history.data
        ? firstUsageAt(history.data.timeSeries, recent.data?.timeSeries ?? [])
        : null,
    [history.data, recent.data],
  );
  const days = useMemo(
    () =>
      chart.data
        ? toChartEntries({
            points: chart.data.timeSeries,
            scale,
            firstUsage,
          })
        : null,
    [chart.data, scale, firstUsage],
  );

  const start =
    mode === "date" ? sinceDate : mode === "all" ? firstUsage : null;
  const startMs = start?.getTime() ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: report on a new start only.
  useEffect(() => {
    onChange(startMs === null ? null : new Date(startMs));
  }, [startMs]);

  const pickSince = (date: Date, preset: string | null = null) => {
    const next = new Date(Math.min(date.getTime(), Date.now()));
    setPresetId(preset);
    setSinceDate(next);
    // A preset sets the range; any other pick only widens it.
    setScale((current) =>
      preset !== null ||
      SCALE_ORDER.indexOf(scaleFor(next)) > SCALE_ORDER.indexOf(current)
        ? scaleFor(next)
        : current,
    );
  };
  const allHint = history.isLoading
    ? "loading…"
    : firstUsage
      ? `since ${UTC_DAY.format(firstUsage)} (UTC)`
      : history.isError
        ? "unavailable without cost statistics access"
        : "nothing recorded yet";

  return (
    <div className="space-y-2">
      <Label id={`${id}-start`}>Start from</Label>
      <RadioGroup
        aria-labelledby={`${id}-start`}
        value={mode}
        onValueChange={(value) => {
          if (isStartMode(value)) setMode(value);
        }}
        className="gap-2.5"
      >
        <ModeRow
          id={`${id}-start-now`}
          value="now"
          label="Now"
          hint={
            schedule === "hourly"
              ? "the first file is this hour"
              : "the first file is today (UTC)"
          }
        />
        <ModeRow
          id={`${id}-start-date`}
          value="date"
          label="A date"
          hint="also write past usage from a day you pick"
        >
          {mode === "date" &&
            (days ? (
              <CostChart
                compact
                sliderLabel="Export from"
                unit={SCALES[scale].unit}
                days={days}
                since={sinceDate}
                firstRequestAt={days[0].day}
                presetId={presetId}
                onPick={pickSince}
              />
            ) : (
              <StartPresetPicker
                since={sinceDate}
                presetId={presetId}
                onPick={pickSince}
              />
            ))}
        </ModeRow>
        <ModeRow
          id={`${id}-start-all`}
          value="all"
          label="All recorded usage"
          hint={allHint}
          disabled={!firstUsage}
        />
      </RadioGroup>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {startFromConsequence({ start, schedule })}
      </p>
    </div>
  );
}

// === internal ===

type StartMode = "now" | "date" | "all";

const DAY_MS = 24 * 3600_000;
const DEFAULT_PRESET_ID = "30d";
const DEFAULT_PRESET_MS = 30 * DAY_MS;
const CHART_DAYS = 30;
const UTC_DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

type ChartScale = "30d" | "90d" | "12m" | "all";
const SCALE_ORDER: ChartScale[] = ["30d", "90d", "12m", "all"];
/** Each range, the statistics timeframe that covers it, and its bar size. */
const SCALES: Record<
  ChartScale,
  { timeframe: StatisticsTimeFrame; spanMs: number | null; unit: string }
> = {
  "30d": { timeframe: "30d", spanMs: 30 * DAY_MS, unit: "day" },
  "90d": { timeframe: "90d", spanMs: 90 * DAY_MS, unit: "3 days" },
  "12m": { timeframe: "12m", spanMs: 365 * DAY_MS, unit: "week" },
  all: { timeframe: "all", spanMs: null, unit: "month" },
};

/** The smallest range that shows a start. */
function scaleFor(start: Date): ChartScale {
  const age = Date.now() - start.getTime();
  return (
    SCALE_ORDER.find((scale) => {
      const span = SCALES[scale].spanMs;
      // A day of slack: a "30d" preset is a few seconds older than 30 days.
      return span === null || age <= span + DAY_MS;
    }) ?? "all"
  );
}

function isStartMode(value: string): value is StartMode {
  return value === "now" || value === "date" || value === "all";
}

type CostPoint = {
  timestamp: string;
  actualCost: number;
  subscriptionCost: number;
};

/** A bucket start from the statistics API; one without a zone is UTC. */
function parseBucket(timestamp: string): Date {
  return /(Z|[+-]\d\d:?\d\d)$/i.test(timestamp)
    ? new Date(timestamp)
    : new Date(`${timestamp.replace(" ", "T")}Z`);
}

/**
 * One chart entry per statistics bucket across the range, empty buckets
 * included. Buckets are cut on whole multiples of their size since the epoch,
 * as the statistics API cuts them.
 */
function toChartEntries({
  points,
  scale,
  firstUsage,
}: {
  points: CostPoint[];
  scale: ChartScale;
  firstUsage: Date | null;
}): ChartDay[] {
  const step =
    getStatisticsBucketIntervalMinutes(SCALES[scale].timeframe) * 60_000;
  const bucketOf = (ms: number) => Math.floor(ms / step);
  const byBucket = new Map<number, number>();
  for (const point of points) {
    const bucket = bucketOf(parseBucket(point.timestamp).getTime());
    byBucket.set(
      bucket,
      (byBucket.get(bucket) ?? 0) + point.actualCost + point.subscriptionCost,
    );
  }
  const now = Date.now();
  const span = SCALES[scale].spanMs;
  const from =
    span !== null
      ? now - span
      : Math.min(
          firstUsage?.getTime() ?? now,
          ...[...byBucket.keys()].map((bucket) => bucket * step),
        );
  const entries: ChartDay[] = [];
  for (let bucket = bucketOf(from); bucket <= bucketOf(now); bucket++) {
    const cost = byBucket.get(bucket) ?? 0;
    // The compact chart draws recorded cost only; requests stay unused.
    entries.push({
      day: new Date(bucket * step),
      end: new Date((bucket + 1) * step),
      requests: 0,
      recordedCost: cost,
      recomputedCost: cost,
    });
  }
  return entries;
}

/**
 * When usage was first recorded: the first monthly bucket with any, narrowed
 * to its first day when that whole month lies inside the daily window.
 */
function firstUsageAt(monthly: CostPoint[], daily: CostPoint[]): Date | null {
  if (monthly.length === 0) return null;
  const month = parseBucket(monthly[0].timestamp);
  const windowStart = Date.now() - CHART_DAYS * DAY_MS;
  if (daily.length > 0 && month.getTime() >= windowStart) {
    return parseBucket(daily[0].timestamp);
  }
  return month;
}

function ModeRow({
  id,
  value,
  label,
  hint,
  disabled = false,
  children,
}: {
  id: string;
  value: StartMode;
  label: string;
  hint: string;
  disabled?: boolean;
  /** Shown under the row, aligned with its text. */
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label
        htmlFor={id}
        className={cn(
          "flex items-start gap-2.5 font-normal",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        )}
      >
        <RadioGroupItem
          id={id}
          value={value}
          disabled={disabled}
          className="mt-0.5"
        />
        <span className="min-w-0 text-sm">
          <span className="font-medium">{label}</span>
          <span className="text-muted-foreground"> — {hint}</span>
        </span>
      </Label>
      {children ? <div className="pl-6.5">{children}</div> : null}
    </div>
  );
}
