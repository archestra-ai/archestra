// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeUsageData } from "./usage.test-data";
import { supportsUsage, usageCube, usageSeries } from "./usage-explorer-data";

const props = makeUsageData();

describe("personal usage explorer", () => {
  it("keeps token-type pivot totals consistent with reported input, output and both cache categories", () => {
    for (const group of ["model", "client"] as const) {
      const cube = usageCube(props, "tokens", group, true);
      expect(cube.total).toBe(1110);
      expect(cube.rows[0].children.map((c) => c.total)).toEqual([
        80, 20, 1000, 10,
      ]);
      expect(cube.splitKeys.reduce((sum, item) => sum + item.total, 0)).toBe(
        cube.total,
      );
      expect(cube.rows[0].extras.cache).toBe(1000);
      expect(cube.rows[0].hasSeries).toBe(false);
      expect(cube.buckets).toEqual([]);
    }
  });
  it("uses request counts rather than billed currency for time pivots", () => {
    expect(usageCube(props, "requests", "time", false).rows[0].series).toEqual([
      3,
    ]);
    expect(usageCube(props, "tokens", "time", false).rows[0].series).toEqual([
      1110,
    ]);
    expect(
      usageCube(props, "subscription", "time", false).rows[0].series,
    ).toEqual([8]);
  });
  it("does not manufacture unavailable timeline values in older responses", () => {
    const older = {
      ...props,
      statistics: {
        ...props.statistics,
        timeSeries: [{ timestamp: "2026-01-01T00:00:00Z", value: 2 }],
      },
    };
    expect(usageCube(older, "billed", "time", false).rows[0].series).toEqual([
      2,
    ]);
    expect(usageCube(older, "requests", "time", false).rows[0].hasSeries).toBe(
      false,
    );
    expect(usageCube(older, "requests", "time", false).rows[0].series).toEqual(
      [],
    );
  });
  it("keeps list-price values out of billed spend and bounds sessions to the returned list", () => {
    expect(supportsUsage("context", "billed")).toBe(false);
    expect(usageCube(props, "billed", "session", false).total).toBe(1);
    expect(usageCube(props, "subscription", "session", false).total).toBe(4);
    expect(
      usageCube(props, "requests", "context", false).rows[0].extras.cost,
    ).toBe(10);
  });
  it("labels unreported clients and shows the full recorded token mix separately", () => {
    expect(usageCube(props, "requests", "client", false).rows[0].label).toBe(
      "Not reported",
    );
    expect(usageCube(props, "tokens", "token", false).total).toBe(1110);
  });
  it("builds independent KPI timelines without substituting currency for missing activity", () => {
    expect(usageSeries(props.statistics, "billed")).toEqual([2]);
    expect(usageSeries(props.statistics, "subscription")).toEqual([8]);
    expect(usageSeries(props.statistics, "requests")).toEqual([3]);
    expect(usageSeries(props.statistics, "tokens")).toEqual([1110]);
    const older = {
      ...props.statistics,
      timeSeries: [{ timestamp: "2026-01-01T00:00:00Z", value: 2 }],
    };
    expect(usageSeries(older, "billed")).toEqual([2]);
    expect(usageSeries(older, "requests")).toBeUndefined();
    expect(usageSeries(older, "tokens")).toBeUndefined();
    expect(usageSeries(older, "subscription")).toBeUndefined();
    expect(
      usageSeries({ ...props.statistics, timeSeries: [] }, "billed"),
    ).toBeUndefined();
  });
});
