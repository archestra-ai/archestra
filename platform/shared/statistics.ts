import { z } from "zod";

export const StatisticsTimeFrameSchema = z.union([
  z.enum(["5m", "15m", "30m", "1h", "24h", "7d", "30d", "90d", "12m", "all"]),
  z
    .templateLiteral(["custom:", z.string(), "_", z.string()])
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
 * Parse a `custom:<start>_<end>` timeframe into its bounds, or return null when
 * the timeframe is a preset or its bounds are malformed.
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

  switch (timeframe) {
    case "5m":
    case "15m":
      return 1;
    case "30m":
    case "1h":
      return 5;
    case "24h":
      return MINUTES_PER_HOUR;
    case "7d":
      return 6 * MINUTES_PER_HOUR;
    case "30d":
      return MINUTES_PER_DAY;
    case "90d":
      return 3 * MINUTES_PER_DAY;
    case "12m":
      return MINUTES_PER_WEEK;
    case "all":
      return MINUTES_PER_MONTH;
    default:
      return MINUTES_PER_HOUR;
  }
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

  switch (timeframe) {
    case "5m":
      return 5;
    case "15m":
      return 15;
    case "30m":
      return 30;
    case "1h":
      return MINUTES_PER_HOUR;
    case "24h":
      return MINUTES_PER_DAY;
    case "7d":
      return 7 * MINUTES_PER_DAY;
    case "30d":
      return 30 * MINUTES_PER_DAY;
    case "90d":
      return 90 * MINUTES_PER_DAY;
    case "12m":
      return MINUTES_PER_YEAR;
    case "all":
      return null;
    default:
      return MINUTES_PER_DAY;
  }
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

const MS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MINUTES_PER_MONTH = 30 * MINUTES_PER_DAY;
const MINUTES_PER_YEAR = 365 * MINUTES_PER_DAY;
