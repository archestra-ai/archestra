import { describe, expect, it } from "vitest";
import { formatRunDuration } from "./run-duration";

const NOW = new Date("2026-08-21T12:00:00.000Z").getTime();

describe("formatRunDuration", () => {
  it("reads in the largest unit that fits", () => {
    const cases: [string, string][] = [
      ["2026-08-21T11:59:56.000Z", "4s"],
      ["2026-08-21T11:59:13.000Z", "47s"],
      ["2026-08-21T11:58:00.000Z", "2m"],
      ["2026-08-21T11:57:56.000Z", "2m 4s"],
      ["2026-08-21T11:00:00.000Z", "1h"],
      ["2026-08-21T10:48:00.000Z", "1h 12m"],
    ];
    for (const [startedAt, expected] of cases) {
      expect(
        formatRunDuration({ startedAt, completedAt: null, now: NOW }),
      ).toBe(expected);
    }
  });

  it("measures a finished run between its own two timestamps", () => {
    expect(
      formatRunDuration({
        startedAt: "2026-08-21T08:00:12.000Z",
        completedAt: "2026-08-21T08:00:58.000Z",
        now: NOW,
      }),
    ).toBe("46s");
  });

  it("measures an unfinished run against now, so a running row is not blank", () => {
    expect(
      formatRunDuration({
        startedAt: "2026-08-21T11:55:00.000Z",
        completedAt: null,
        now: NOW,
      }),
    ).toBe("5m");
  });

  it("has nothing to say without a start, or when the clock ran backwards", () => {
    expect(
      formatRunDuration({ startedAt: null, completedAt: null, now: NOW }),
    ).toBeNull();
    expect(
      formatRunDuration({
        startedAt: "2026-08-21T12:00:10.000Z",
        completedAt: "2026-08-21T12:00:00.000Z",
        now: NOW,
      }),
    ).toBeNull();
  });
});
