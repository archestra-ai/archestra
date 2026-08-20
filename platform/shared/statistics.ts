import { z } from "zod";

const StatisticsTimeFramePresetSchema = z.enum([
  "5m",
  "15m",
  "30m",
  "1h",
  "24h",
  "7d",
  "30d",
  "90d",
  "12m",
  "all",
]);

export const StatisticsTimeFrameSchema = z.union([
  StatisticsTimeFramePresetSchema,
  z
    .templateLiteral(["custom:", z.string(), "_", z.string()])
    // The shape alone is not enough: bounds that are not dates, or that run
    // backwards, parse to null further down, and a null range contributes no
    // date predicate at all — silently widening a "custom range" query to every
    // interaction ever recorded. Reject them at the boundary instead.
    .refine((timeframe) => parseCustomStatisticsTimeframe(timeframe) !== null, {
      message:
        "Custom timeframe bounds must be parseable dates, with the end after the start",
    })
    .describe("Custom timeframe must be in format 'custom:startTime_endTime'"),
]);

export type StatisticsTimeFrame = z.infer<typeof StatisticsTimeFrameSchema>;

/**
 * How precise a statistics chart's time-axis label has to be for every bucket
 * on that chart to get a distinct label.
 */
export type StatisticsAxisLabelPrecision =
  | "time"
  | "dateTime"
  | "date"
  | "dateYear"
  | "monthYear";

/**
 * Parse a `custom:<start>_<end>` timeframe into its bounds. Returns null for a
 * preset, for bounds that are not dates, and for a range that ends at or before
 * it starts — the last of which describes no window at all, and would otherwise
 * reach the query builder as an unsatisfiable pair of conditions.
 */
export function parseCustomStatisticsTimeframe(
  timeframe: string,
): { startTime: Date; endTime: Date } | null {
  if (!timeframe.startsWith("custom:")) {
    return null;
  }

  const [startTimeStr, endTimeStr] = timeframe
    .slice("custom:".length)
    .split("_");

  if (!startTimeStr || !endTimeStr) {
    return null;
  }

  const startTime = new Date(startTimeStr);
  const endTime = new Date(endTimeStr);

  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
    return null;
  }

  if (endTime.getTime() <= startTime.getTime()) {
    return null;
  }

  return { startTime, endTime };
}

/**
 * Width, in minutes, of one point on a statistics time series. The backend
 * buckets its aggregations to this width.
 */
export function getStatisticsBucketIntervalMinutes(
  timeframe: StatisticsTimeFrame,
): number {
  const customRange = parseCustomStatisticsTimeframe(timeframe);
  if (customRange) {
    const durationMinutes = getRangeDurationMinutes(customRange);

    if (durationMinutes <= 2 * MINUTES_PER_HOUR) return 5;
    if (durationMinutes <= 48 * MINUTES_PER_HOUR) return MINUTES_PER_HOUR;
    if (durationMinutes <= 30 * MINUTES_PER_DAY) return MINUTES_PER_DAY;
    return MINUTES_PER_WEEK;
  }

  return getPresetTimeframe(timeframe).bucketMinutes;
}

/**
 * Pick the coarsest axis-label precision that still gives every bucket on the
 * chart its own label.
 *
 * A label has to name the unit the buckets are cut on, plus whatever coarser
 * units the range spans. Labelling six-hourly buckets with the day alone, for
 * instance, repeats the same day on four consecutive ticks — and makes the
 * tooltip just as ambiguous, since it is keyed off the same label.
 */
export function getStatisticsAxisLabelPrecision(
  timeframe: StatisticsTimeFrame,
): StatisticsAxisLabelPrecision {
  const bucketMinutes = getStatisticsBucketIntervalMinutes(timeframe);
  const spanMinutes = getTimeframeSpanMinutes(timeframe);

  // Buckets a month or wider: the day carries no information, but two buckets
  // a whole year apart would otherwise collide on the same month.
  if (bucketMinutes >= MINUTES_PER_MONTH) {
    return "monthYear";
  }

  if (bucketMinutes >= MINUTES_PER_DAY) {
    // Day-or-wider buckets are already distinct within a year; past that, the
    // same calendar day comes round again.
    return spanMinutes === null || spanMinutes > MINUTES_PER_YEAR
      ? "dateYear"
      : "date";
  }

  // Sub-day buckets always need the time of day, plus the date once the window
  // covers more than a single day. A window of exactly a day stays on the bare
  // clock time: the rolling filter behind it can clip a partial bucket onto
  // each end, whose two ticks share a clock reading, but they sit at opposite
  // extremes of the axis and dating all 24 ticks to disambiguate them costs
  // more legibility than it buys.
  return spanMinutes !== null && spanMinutes <= MINUTES_PER_DAY
    ? "time"
    : "dateTime";
}

// ─── Internal ───────────────────────────────────────────────────────────────

/**
 * Total span, in minutes, covered by a timeframe, or null when it is unbounded
 * ("all", whose span depends on how far back the data goes).
 */
function getTimeframeSpanMinutes(
  timeframe: StatisticsTimeFrame,
): number | null {
  const customRange = parseCustomStatisticsTimeframe(timeframe);
  if (customRange) {
    return getRangeDurationMinutes(customRange);
  }

  return getPresetTimeframe(timeframe).spanMinutes;
}

function getPresetTimeframe(timeframe: StatisticsTimeFrame) {
  return PRESET_TIMEFRAMES[
    timeframe in PRESET_TIMEFRAMES
      ? (timeframe as StatisticsTimeFramePreset)
      : "24h"
  ];
}

function getRangeDurationMinutes({
  startTime,
  endTime,
}: {
  startTime: Date;
  endTime: Date;
}): number {
  return (endTime.getTime() - startTime.getTime()) / MS_PER_MINUTE;
}

type StatisticsTimeFramePreset = z.infer<
  typeof StatisticsTimeFramePresetSchema
>;

const MS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MINUTES_PER_MONTH = 30 * MINUTES_PER_DAY;
const MINUTES_PER_YEAR = 365 * MINUTES_PER_DAY;

/**
 * Window and bucket width of each preset, side by side so the two cannot drift
 * apart: the axis-label precision is chosen from both at once, and a bucket is
 * only ever meaningful relative to the window it subdivides.
 */
const PRESET_TIMEFRAMES: Record<
  StatisticsTimeFramePreset,
  { spanMinutes: number | null; bucketMinutes: number }
> = {
  "5m": { spanMinutes: 5, bucketMinutes: 1 },
  "15m": { spanMinutes: 15, bucketMinutes: 1 },
  "30m": { spanMinutes: 30, bucketMinutes: 5 },
  "1h": { spanMinutes: MINUTES_PER_HOUR, bucketMinutes: 5 },
  "24h": { spanMinutes: MINUTES_PER_DAY, bucketMinutes: MINUTES_PER_HOUR },
  "7d": {
    spanMinutes: 7 * MINUTES_PER_DAY,
    bucketMinutes: 6 * MINUTES_PER_HOUR,
  },
  "30d": { spanMinutes: 30 * MINUTES_PER_DAY, bucketMinutes: MINUTES_PER_DAY },
  "90d": {
    spanMinutes: 90 * MINUTES_PER_DAY,
    bucketMinutes: 3 * MINUTES_PER_DAY,
  },
  "12m": { spanMinutes: MINUTES_PER_YEAR, bucketMinutes: MINUTES_PER_WEEK },
  // Unbounded, and aggregated by calendar month — whose real width varies, so
  // only the order of magnitude is ever read off `bucketMinutes` here.
  all: { spanMinutes: null, bucketMinutes: MINUTES_PER_MONTH },
};
