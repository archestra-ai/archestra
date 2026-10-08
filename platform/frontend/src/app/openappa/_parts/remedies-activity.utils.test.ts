import { describe, expect, test } from "vitest";
import {
  activityBars,
  activityHeadline,
  activityTotals,
} from "./remedies-activity.utils";

const days = [
  { date: "2026-10-02", blocked: 1, approved: 3, cleaned: 2 },
  { date: "2026-10-03", blocked: 0, approved: 0, cleaned: 0 },
  { date: "2026-10-04", blocked: 2, approved: 5, cleaned: 6 },
];

describe("activityBars", () => {
  test("labels each day by weekday without the zone shifting it", () => {
    expect(activityBars(days, "en-US").map((bar) => bar.label)).toEqual([
      "Fri",
      "Sat",
      "Sun",
    ]);
    expect(activityBars(days, "en-US")[0]).toMatchObject({
      date: "2026-10-02",
      blocked: 1,
      approved: 3,
      cleaned: 2,
    });
  });
});

describe("activityTotals and activityHeadline", () => {
  test("sums the week and words the headline", () => {
    const totals = activityTotals(days);
    expect(totals).toEqual({ blocked: 3, approved: 8, cleaned: 8 });
    expect(activityHeadline(totals)).toBe(
      "19 denied · 8 approved · 8 cleaned · 3 blocked",
    );
  });

  test("an empty week says nothing blocked", () => {
    expect(activityHeadline(activityTotals([]))).toBe("nothing blocked");
  });
});
