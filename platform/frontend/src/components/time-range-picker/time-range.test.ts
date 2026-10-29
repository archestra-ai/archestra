import { describe, expect, it } from "vitest";
import {
  statisticsTimeframeToTimeRange,
  timeRangeToStatisticsTimeframe,
} from "./statistics-time-range";
import {
  describeTimeRange,
  parseTimeExpression,
  shiftTimeRange,
  zoomOutTimeRange,
} from "./time-range";

// Tuesday, Oct 13 2026, 12:00 local time.
const NOW = new Date(2026, 9, 13, 12, 0);

describe("parseTimeExpression", () => {
  it.each([
    ["now", new Date(2026, 9, 13, 12, 0)],
    ["now-6h", new Date(2026, 9, 13, 6, 0)],
    ["now - 15m", new Date(2026, 9, 13, 11, 45)],
    ["now-7d", new Date(2026, 9, 6, 12, 0)],
    ["now-1M", new Date(2026, 8, 13, 12, 0)],
    ["now/d", new Date(2026, 9, 13, 0, 0)],
    ["now-1d/d", new Date(2026, 9, 12, 0, 0)],
    ["now/w", new Date(2026, 9, 12, 0, 0)],
    ["2026-10-01", new Date(2026, 9, 1, 0, 0)],
    ["2026-10-01 09:30", new Date(2026, 9, 1, 9, 30)],
    ["2026-10-01T09:30", new Date(2026, 9, 1, 9, 30)],
    ["2026-10-01T09:30:00.000Z", new Date("2026-10-01T09:30:00.000Z")],
  ])("reads %s", (text, expected) => {
    expect(parseTimeExpression(text, NOW)).toEqual(expected);
  });

  it.each([
    "yesterday",
    "now-6",
    "now-6x",
    "2026-02-31",
    "2026-13-01",
    "",
  ])("names no moment for %j", (text) => {
    expect(parseTimeExpression(text, NOW)).toBeUndefined();
  });
});

describe("describeTimeRange", () => {
  it("names a quick range by its label", () => {
    expect(describeTimeRange({ from: "now-6h", to: "now" }, NOW)).toBe(
      "Last 6 hours",
    );
  });

  it("names any other range by its ends", () => {
    expect(
      describeTimeRange(
        { from: "2026-10-12 09:00", to: "2026-10-12 18:00" },
        NOW,
      ),
    ).toBe("Oct 12, 09:00 – 18:00");
    expect(describeTimeRange({ from: "now-90m", to: "now" }, NOW)).toBe(
      "Oct 13, 10:30 – now",
    );
  });
});

describe("shiftTimeRange", () => {
  it("moves a range one span earlier, as exact times", () => {
    expect(shiftTimeRange({ from: "now-6h", to: "now" }, -1, NOW)).toEqual({
      from: "2026-10-13 00:00",
      to: "2026-10-13 06:00",
    });
  });

  it("stops a later move at now and keeps the span", () => {
    expect(
      shiftTimeRange(
        { from: "2026-10-13 04:00", to: "2026-10-13 08:00" },
        1,
        NOW,
      ),
    ).toEqual({ from: "2026-10-13 08:00", to: "2026-10-13 12:00" });
  });
});

describe("zoomOutTimeRange", () => {
  it("keeps a range that ends now ending now, twice as long", () => {
    expect(zoomOutTimeRange({ from: "now-6h", to: "now" }, NOW)).toEqual({
      from: "now-720m",
      to: "now",
    });
  });

  it("doubles a past range around its middle", () => {
    expect(
      zoomOutTimeRange(
        { from: "2026-10-12 10:00", to: "2026-10-12 12:00" },
        NOW,
      ),
    ).toEqual({ from: "2026-10-12 09:00", to: "2026-10-12 13:00" });
  });
});

describe("statistics timeframes", () => {
  it("keeps the API's named ranges, so they keep rolling", () => {
    expect(
      timeRangeToStatisticsTimeframe({ from: "now-7d", to: "now" }, NOW),
    ).toBe("7d");
    expect(statisticsTimeframeToTimeRange("12m")).toEqual({
      from: "now-12M",
      to: "now",
    });
    expect(
      timeRangeToStatisticsTimeframe({ from: "all", to: "now" }, NOW),
    ).toBe("all");
  });

  it("sends any other range as its exact bounds at that moment", () => {
    expect(
      timeRangeToStatisticsTimeframe({ from: "now-6h", to: "now" }, NOW),
    ).toBe(
      `custom:${new Date(2026, 9, 13, 6, 0).toISOString()}_${NOW.toISOString()}`,
    );
  });

  it("keeps exact bounds to the millisecond, so no minute is lost", () => {
    const timeframe =
      "custom:2026-07-01T00:00:00.000Z_2026-07-31T23:59:59.999Z" as const;
    expect(
      timeRangeToStatisticsTimeframe(
        statisticsTimeframeToTimeRange(timeframe),
        NOW,
      ),
    ).toBe(timeframe);
  });

  it("refuses a range that ends before it starts", () => {
    expect(
      timeRangeToStatisticsTimeframe(
        { from: "2026-10-13 10:00", to: "2026-10-13 09:00" },
        NOW,
      ),
    ).toBeUndefined();
  });
});
