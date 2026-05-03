import { describe, expect, test } from "vitest";
import { getStatisticsRefetchInterval } from "./statistics.query";

describe("getStatisticsRefetchInterval", () => {
  test("polls active rolling timeframes every 30 seconds", () => {
    expect(getStatisticsRefetchInterval("1h")).toBe(30_000);
    expect(getStatisticsRefetchInterval("24h")).toBe(30_000);
    expect(getStatisticsRefetchInterval("all")).toBe(30_000);
  });

  test("polls custom ranges that have not ended", () => {
    expect(
      getStatisticsRefetchInterval(
        "custom:2026-01-01T00:00:00.000Z_2026-01-02T00:00:00.000Z",
        Date.parse("2026-01-01T12:00:00.000Z"),
      ),
    ).toBe(30_000);
  });

  test("does not poll completed custom ranges", () => {
    expect(
      getStatisticsRefetchInterval(
        "custom:2026-01-01T00:00:00.000Z_2026-01-02T00:00:00.000Z",
        Date.parse("2026-01-03T00:00:00.000Z"),
      ),
    ).toBe(false);
  });
});
