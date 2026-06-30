import { describe, expect, test } from "vitest";
import { calculateCostSavings } from "./interaction.utils";

describe("calculateCostSavings", () => {
  test("treats the stored cost as the actual cost and never double-counts TOON savings", () => {
    // Regression: previously `actualCost` was derived as
    // `baselineCost - totalSavings`, which simplifies to `cost - toonCostSavings`.
    // When TOON savings exceeded the (already TOON-reduced) cost this produced a
    // negative actual cost and a savings percentage well above 100%.
    const result = calculateCostSavings({
      cost: "0.05",
      baselineCost: "0.3926",
      toonCostSavings: "1.8",
      toonTokensBefore: 10_000,
      toonTokensAfter: 1_000,
    });

    // Actual cost is exactly the stored spend — never negative.
    expect(result.actualCost).toBeCloseTo(0.05, 10);
    // Model optimization savings = baselineCost - cost.
    expect(result.costOptimizationSavings).toBeCloseTo(0.3426, 10);
    // Total savings = model optimization + TOON compression.
    expect(result.totalSavings).toBeCloseTo(0.3426 + 1.8, 10);
    // Estimated cost sits exactly totalSavings above the actual spend.
    expect(result.estimatedCost).toBeCloseTo(0.05 + 0.3426 + 1.8, 10);
    // Percentage is bounded to 0–100 for non-negative savings.
    expect(result.savingsPercent).toBeGreaterThan(0);
    expect(result.savingsPercent).toBeLessThan(100);
    expect(result.toonTokensSaved).toBe(9_000);
    expect(result.hasSavings).toBe(true);
  });

  test("reports no savings when there is no optimization or compression", () => {
    const result = calculateCostSavings({
      cost: "0.25",
      baselineCost: "0.25",
      toonCostSavings: "0",
      toonTokensBefore: null,
      toonTokensAfter: null,
    });

    expect(result.actualCost).toBeCloseTo(0.25, 10);
    expect(result.estimatedCost).toBeCloseTo(0.25, 10);
    expect(result.totalSavings).toBeCloseTo(0, 10);
    expect(result.savingsPercent).toBe(0);
    expect(result.toonTokensSaved).toBeNull();
    expect(result.hasSavings).toBe(false);
  });

  test("handles only model-optimization savings (no TOON)", () => {
    const result = calculateCostSavings({
      cost: "0.10",
      baselineCost: "0.40",
      toonCostSavings: null,
      toonTokensBefore: null,
      toonTokensAfter: null,
    });

    expect(result.actualCost).toBeCloseTo(0.1, 10);
    expect(result.costOptimizationSavings).toBeCloseTo(0.3, 10);
    expect(result.totalSavings).toBeCloseTo(0.3, 10);
    expect(result.estimatedCost).toBeCloseTo(0.4, 10);
    // 0.3 / 0.4 = 75%
    expect(result.savingsPercent).toBeCloseTo(75, 10);
  });

  test("guards against a zero estimated cost", () => {
    const result = calculateCostSavings({
      cost: null,
      baselineCost: null,
      toonCostSavings: null,
      toonTokensBefore: null,
      toonTokensAfter: null,
    });

    expect(result.actualCost).toBe(0);
    expect(result.estimatedCost).toBe(0);
    expect(result.savingsPercent).toBe(0);
  });
});
