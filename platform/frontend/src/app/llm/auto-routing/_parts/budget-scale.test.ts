// @vitest-environment node
import { describe, expect, it } from "vitest";
import { budgetScale, MAX_BUDGET, MIN_BUDGET } from "./budget-scale";

const positions = (steps: number) =>
  Array.from({ length: steps + 1 }, (_, i) => i);

describe("budgetScale", () => {
  it.each([
    [MIN_BUDGET, MIN_BUDGET, 0.2],
    [0.37, 0.02, 7.4],
    [50, 2.5, 1000],
    [MAX_BUDGET, 500_000_000, MAX_BUDGET],
  ])("spans saved %d over [%d, %d] in increasing cents and includes it", (saved, lo, hi) => {
    const scale = budgetScale(saved);
    const budgets = positions(scale.steps).map(scale.budgetAt);

    expect(budgets[0]).toBe(lo);
    expect(budgets.at(-1)).toBe(hi);
    expect(budgets).toContain(saved);
    expect(scale.budgetAt(Math.round(scale.savedPosition))).toBe(saved);
    for (const [i, budget] of budgets.entries()) {
      expect(Math.round(budget * 100) / 100).toBe(budget);
      if (i > 0) expect(budget).toBeGreaterThanOrEqual(budgets[i - 1]);
    }
  });
});
