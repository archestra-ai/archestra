import { describe, expect, test } from "vitest";
import {
  activityBars,
  activityTotals,
  cleaningsHeadline,
  reviewsHeadline,
} from "./remedies-activity.utils";

const days = [
  { date: "2026-10-02", approved: 3, denied: 1, cleaned: 2 },
  { date: "2026-10-03", approved: 0, denied: 0, cleaned: 0 },
  { date: "2026-10-04", approved: 5, denied: 0, cleaned: 6 },
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
      approved: 3,
      denied: 1,
      cleaned: 2,
    });
  });
});

describe("activityTotals and headlines", () => {
  test("sums the week and words the headlines", () => {
    const totals = activityTotals(days);
    expect(totals).toEqual({ approved: 8, denied: 1, cleaned: 8 });
    expect(reviewsHeadline(totals)).toBe("8 approved · 1 denied");
    expect(cleaningsHeadline(totals)).toBe("8");
  });

  test("an empty week says none yet", () => {
    const totals = activityTotals([]);
    expect(reviewsHeadline(totals)).toBe("none yet");
    expect(cleaningsHeadline(totals)).toBe("none yet");
  });
});
