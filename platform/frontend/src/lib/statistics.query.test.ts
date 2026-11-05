import { describe, expect, it } from "vitest";
import { statisticsRefresh } from "./statistics.query";

describe("statisticsRefresh", () => {
  it("refreshes short windows often and long windows rarely", () => {
    expect(statisticsRefresh("1h").refetchInterval).toBe(30_000);
    expect(statisticsRefresh("24h").refetchInterval).toBe(60_000);
    expect(statisticsRefresh("7d").refetchInterval).toBe(300_000);
    expect(statisticsRefresh("30d").refetchInterval).toBe(300_000);
    expect(
      statisticsRefresh(
        "custom:2026-10-01T00:00:00.000Z_2026-10-01T01:00:00.000Z",
      ).refetchInterval,
    ).toBe(30_000);
  });
});
