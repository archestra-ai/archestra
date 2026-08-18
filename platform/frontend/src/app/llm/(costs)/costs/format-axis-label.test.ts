import {
  getStatisticsBucketIntervalMinutes,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { formatStatisticsAxisLabel } from "./format-axis-label";

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;

/**
 * How far back each timeframe reaches. One window's worth of buckets is laid
 * end to end across it, so a label too coarse for the bucket width shows up as
 * two buckets sharing a tick.
 */
const TIMEFRAME_SPAN_MINUTES: Record<string, number> = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": HOUR_MINUTES,
  "24h": DAY_MINUTES,
  "7d": 7 * DAY_MINUTES,
  "30d": 30 * DAY_MINUTES,
  "90d": 90 * DAY_MINUTES,
  "12m": 365 * DAY_MINUTES,
  "custom:2026-07-01T00:00:00.000Z_2026-07-01T02:00:00.000Z": 2 * HOUR_MINUTES,
  "custom:2026-07-01T00:00:00.000Z_2026-07-02T23:59:59.999Z": 2 * DAY_MINUTES,
  "custom:2026-07-01T00:00:00.000Z_2026-07-21T00:00:00.000Z": 20 * DAY_MINUTES,
  "custom:2024-01-01T00:00:00.000Z_2026-01-01T00:00:00.000Z": 731 * DAY_MINUTES,
};

describe("formatStatisticsAxisLabel", () => {
  it.each(
    Object.keys(TIMEFRAME_SPAN_MINUTES),
  )("gives every bucket across %s its own label", (timeframe) => {
    const bucketMinutes = getStatisticsBucketIntervalMinutes(
      timeframe as StatisticsTimeFrame,
    );
    const bucketCount = Math.ceil(
      TIMEFRAME_SPAN_MINUTES[timeframe] / bucketMinutes,
    );
    const start = new Date("2026-01-01T00:00:00.000Z").getTime();

    const labels = Array.from({ length: bucketCount }, (_, i) =>
      formatStatisticsAxisLabel(
        new Date(start + i * bucketMinutes * MINUTE_MS).toISOString(),
        timeframe as StatisticsTimeFrame,
      ),
    );

    expect(new Set(labels).size).toBe(labels.length);
  });

  it("gives every month of an all-time chart its own label", () => {
    // "all" aggregates by calendar month, however far back the data goes.
    const labels = Array.from({ length: 36 }, (_, i) =>
      formatStatisticsAxisLabel(new Date(2024, i, 1).toISOString(), "all"),
    );

    expect(new Set(labels).size).toBe(labels.length);
  });

  // Labels are rendered in the viewer's own timezone, so the expected strings
  // are pinned against locally-constructed bucket starts.
  it.each([
    // Six-hourly buckets: the day on its own would label four ticks alike.
    ["7d", new Date(2026, 0, 2, 18), "Jan 2, 18:00"],
    // Hourly buckets inside a single day need only the time.
    ["24h", new Date(2026, 0, 2, 18), "18:00"],
    // Daily buckets read cleanest as a bare date.
    ["30d", new Date(2026, 0, 2), "Jan 2"],
    ["all", new Date(2026, 0, 1), "Jan 2026"],
  ] as const)("labels a %s bucket as %s", (timeframe, bucket, expected) => {
    expect(formatStatisticsAxisLabel(bucket.toISOString(), timeframe)).toBe(
      expected,
    );
  });
});
