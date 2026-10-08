// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  blockedCallsBars,
  blockedCallsHeadline,
  blockedCallsTotals,
} from "./blocked-calls.utils";

const days = [
  { date: "2026-10-02", blocked: 3, remedied: 1 },
  { date: "2026-10-03", blocked: 0, remedied: 0 },
  { date: "2026-10-04", blocked: 2, remedied: 2 },
];

describe("blockedCallsTotals", () => {
  test("sums the window and splits what stayed blocked", () => {
    expect(blockedCallsTotals(days)).toEqual({
      blocked: 5,
      remedied: 3,
      stayed: 2,
    });
    expect(blockedCallsTotals([])).toEqual({
      blocked: 0,
      remedied: 0,
      stayed: 0,
    });
  });
});

describe("blockedCallsBars", () => {
  test("names each day by its weekday and splits the bar", () => {
    expect(blockedCallsBars(days, "en-US")).toEqual([
      { date: "2026-10-02", label: "Fri", remedied: 1, stayed: 2 },
      { date: "2026-10-03", label: "Sat", remedied: 0, stayed: 0 },
      { date: "2026-10-04", label: "Sun", remedied: 2, stayed: 0 },
    ]);
  });
});

describe("blockedCallsHeadline", () => {
  test("reads as the legend does, and says so when nothing was blocked", () => {
    expect(blockedCallsHeadline(blockedCallsTotals(days))).toBe(
      "5 blocked · 3 approved or cleaned",
    );
    expect(blockedCallsHeadline(blockedCallsTotals([]))).toBe(
      "nothing blocked",
    );
  });
});
