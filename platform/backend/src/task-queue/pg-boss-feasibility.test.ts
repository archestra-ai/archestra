import { describe, expect, test } from "@/test";
import { TASK_QUEUE_CAPABILITY_MATRIX } from "./capabilities";
import {
  PG_BOSS_FEASIBILITY_REPORT,
  analyzePgBossFeasibility,
} from "./pg-boss-feasibility";

describe("analyzePgBossFeasibility", () => {
  test("reports counts that match matrix size", () => {
    const report = analyzePgBossFeasibility();
    const total =
      report.supportedCount + report.partialCount + report.unsupportedCount;
    expect(total).toBe(TASK_QUEUE_CAPABILITY_MATRIX.length);
  });

  test("flags required partial/unsupported items as blocking gaps", () => {
    const report = analyzePgBossFeasibility();
    const requiredGaps = TASK_QUEUE_CAPABILITY_MATRIX.filter(
      (item) =>
        item.required && (item.pgBoss === "partial" || item.pgBoss === "unsupported"),
    );

    expect(report.blockingGaps.map((g) => g.feature).sort()).toEqual(
      requiredGaps.map((g) => g.feature).sort(),
    );
  });

  test("exports a stable default report", () => {
    expect(PG_BOSS_FEASIBILITY_REPORT.partialCount).toBeGreaterThanOrEqual(0);
    expect(PG_BOSS_FEASIBILITY_REPORT.supportedCount).toBeGreaterThan(0);
  });
});
