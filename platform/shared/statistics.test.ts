import { describe, expect, it } from "vitest";
import {
  getStatisticsAxisLabelPrecision,
  getStatisticsBucketIntervalMinutes,
  parseCustomStatisticsTimeframe,
  StatisticsTimeFrameSchema,
} from "./statistics";

describe("StatisticsTimeFrameSchema", () => {
  it.each([
    "24h",
    "all",
    "custom:2026-07-01T00:00:00.000Z_2026-07-31T23:59:59.999Z",
  ])("accepts %s", (timeframe) => {
    expect(StatisticsTimeFrameSchema.safeParse(timeframe).success).toBe(true);
  });

  it.each([
    // Shaped like a custom range, but the bounds are not dates. Accepting one
    // drops the date predicate from the query it feeds, widening a "custom
    // range" request to every interaction ever recorded.
    ["unparseable bounds", "custom:not-a-date_also-not-a-date"],
    ["one unparseable bound", "custom:2026-07-01T00:00:00.000Z_later"],
    ["no separator", "custom:2026-07-01T00:00:00.000Z"],
    ["an unknown preset", "3d"],
  ])("rejects %s", (_case, timeframe) => {
    expect(StatisticsTimeFrameSchema.safeParse(timeframe).success).toBe(false);
  });
});

describe("parseCustomStatisticsTimeframe", () => {
  it("parses the bounds of a custom timeframe", () => {
    expect(
      parseCustomStatisticsTimeframe(
        "custom:2026-07-01T00:00:00.000Z_2026-07-31T23:59:59.999Z",
      ),
    ).toEqual({
      startTime: new Date("2026-07-01T00:00:00.000Z"),
      endTime: new Date("2026-07-31T23:59:59.999Z"),
    });
  });

  it.each([
    ["a preset timeframe", "24h"],
    ["a missing separator", "custom:2026-07-01T00:00:00.000Z"],
    ["unparseable bounds", "custom:not-a-date_also-not-a-date"],
  ])("returns null for %s", (_case, timeframe) => {
    expect(parseCustomStatisticsTimeframe(timeframe)).toBeNull();
  });
});

describe("getStatisticsBucketIntervalMinutes", () => {
  it.each([
    ["5m", 1],
    ["15m", 1],
    ["30m", 5],
    ["1h", 5],
    ["24h", 60],
    ["7d", 6 * 60],
    ["30d", 24 * 60],
    ["90d", 3 * 24 * 60],
    ["12m", 7 * 24 * 60],
    ["all", 30 * 24 * 60],
  ] as const)("buckets %s into %i-minute slices", (timeframe, expected) => {
    expect(getStatisticsBucketIntervalMinutes(timeframe)).toBe(expected);
  });

  it.each([
    ["custom:2026-07-01T00:00:00.000Z_2026-07-01T01:00:00.000Z", 5],
    ["custom:2026-07-01T00:00:00.000Z_2026-07-02T00:00:00.000Z", 60],
    ["custom:2026-07-01T00:00:00.000Z_2026-07-20T00:00:00.000Z", 24 * 60],
    ["custom:2026-01-01T00:00:00.000Z_2026-07-01T00:00:00.000Z", 7 * 24 * 60],
  ] as const)("scales the bucket to the width of %s", (timeframe, expected) => {
    expect(getStatisticsBucketIntervalMinutes(timeframe)).toBe(expected);
  });
});

describe("getStatisticsAxisLabelPrecision", () => {
  it.each([
    // Sub-day buckets inside a single day: the time of day is enough.
    ["5m", "time"],
    ["30m", "time"],
    ["1h", "time"],
    ["24h", "time"],
    // Sub-day buckets spread over several days: the day alone would repeat on
    // every one of the four six-hour buckets it covers.
    ["7d", "dateTime"],
    // Day-or-wider buckets inside a year: the calendar day is unambiguous.
    ["30d", "date"],
    ["90d", "date"],
    ["12m", "date"],
    // Month-wide buckets: the day says nothing, the year keeps them apart.
    ["all", "monthYear"],
  ] as const)("labels %s buckets with %s precision", (timeframe, expected) => {
    expect(getStatisticsAxisLabelPrecision(timeframe)).toBe(expected);
  });

  it.each([
    // 10 hours of 5-minute buckets, all within one calendar day.
    ["custom:2026-07-01T08:00:00.000Z_2026-07-01T18:00:00.000Z", "time"],
    // Two days of hourly buckets — 24 ticks per day under a day-only label.
    ["custom:2026-07-01T00:00:00.000Z_2026-07-02T23:59:59.999Z", "dateTime"],
    // Three weeks of daily buckets.
    ["custom:2026-07-01T00:00:00.000Z_2026-07-21T00:00:00.000Z", "date"],
    // Years of weekly buckets: the same calendar day comes round again.
    ["custom:2024-01-01T00:00:00.000Z_2026-01-01T00:00:00.000Z", "dateYear"],
  ] as const)("labels %s with %s precision", (timeframe, expected) => {
    expect(getStatisticsAxisLabelPrecision(timeframe)).toBe(expected);
  });
});
