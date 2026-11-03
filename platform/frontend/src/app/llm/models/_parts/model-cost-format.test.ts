// @vitest-environment node
import { expect, test } from "vitest";
import { formatModelCost, formatUsdShort } from "./model-cost-format";

test("keeps compact totals readable while preserving non-zero sub-cent costs", () => {
  expect(formatUsdShort(412.3456789012)).toBe("$412.35");
  expect(formatUsdShort(0.015)).toBe("$0.02");
  expect(formatUsdShort(0.01)).toBe("$0.01");
  expect(formatUsdShort(0)).toBe("$0.00");
  expect(formatUsdShort(0.006)).toBe("$0.006");
  expect(formatUsdShort(0.0000000001)).toBe("$0.0000000001");
  expect(formatUsdShort(-0.006)).toBe("-$0.006");
  expect(formatUsdShort(-412.3456789012)).toBe("-$412.35");
  expect(formatUsdShort(1_234.56)).toBe("$1,235");
  expect(formatUsdShort(123_456.78)).toBe("$123.5k");
  expect(formatModelCost(412.3456789012)).toBe("$412.3456789012");
});
