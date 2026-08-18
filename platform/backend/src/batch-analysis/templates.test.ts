import { describe, expect, test } from "vitest";
import { BatchAnalysisColumnsSchema } from "@/types/batch-analysis";
import { BATCH_ANALYSIS_TEMPLATES } from "./templates";

describe("BATCH_ANALYSIS_TEMPLATES", () => {
  test("every template's columns satisfy the analysis column schema", () => {
    for (const template of BATCH_ANALYSIS_TEMPLATES) {
      const parsed = BatchAnalysisColumnsSchema.safeParse(template.columns);
      expect(
        parsed.success,
        `${template.id}: ${parsed.success ? "" : parsed.error.message}`,
      ).toBe(true);
    }
  });

  test("template ids are unique", () => {
    const ids = BATCH_ANALYSIS_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
