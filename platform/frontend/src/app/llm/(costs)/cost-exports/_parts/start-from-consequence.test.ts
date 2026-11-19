import { describe, expect, it } from "vitest";
import { startFromConsequence } from "./start-from-consequence";

// 05:30 UTC on Nov 11: the day and the hour in progress are both partial.
const now = new Date("2026-11-11T05:30:00Z");

describe("startFromConsequence", () => {
  it("counts the completed UTC days a backfill writes right away", () => {
    expect(
      startFromConsequence({
        start: new Date("2026-11-09T08:00:00Z"),
        schedule: "daily",
        now,
      }),
    ).toBe("Writes about 2 daily files now, then one per day.");
  });

  it("counts whole UTC hours for an hourly export", () => {
    expect(
      startFromConsequence({
        start: new Date("2026-11-10T05:59:00Z"),
        schedule: "hourly",
        now,
      }),
    ).toBe("Writes about 24 hourly files now, then one per hour.");
  });

  it("says one file for a single completed period", () => {
    expect(
      startFromConsequence({
        start: new Date("2026-11-10T23:00:00Z"),
        schedule: "daily",
        now,
      }),
    ).toBe("Writes about 1 daily file now, then one per day.");
  });

  it("writes nothing past when the start is in the period in progress", () => {
    expect(
      startFromConsequence({
        start: new Date("2026-11-11T00:10:00Z"),
        schedule: "daily",
        now,
      }),
    ).toBe("The first file is written once this day ends, then one per day.");
    expect(startFromConsequence({ start: null, schedule: "hourly", now })).toBe(
      "The first file is written once this hour ends, then one per hour.",
    );
  });
});
