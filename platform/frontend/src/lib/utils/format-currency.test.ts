// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatCurrency } from "./format-currency";

describe("formatCurrency", () => {
  it("rounds to two decimals", () => {
    expect(formatCurrency(43.9675)).toBe("$43.97");
    expect(formatCurrency(0.3469)).toBe("$0.35");
    expect(formatCurrency(12.5)).toBe("$12.50");
  });

  it("groups thousands", () => {
    expect(formatCurrency(2054.4463)).toBe("$2,054.45");
    expect(formatCurrency(1_234_567.891)).toBe("$1,234,567.89");
  });

  it("shows tiny non-zero amounts as <$0.01 instead of $0.00", () => {
    expect(formatCurrency(0.0042)).toBe("<$0.01");
    expect(formatCurrency(0.000001)).toBe("<$0.01");
  });

  it("shows an amount that rounds up to a cent as $0.01", () => {
    expect(formatCurrency(0.0051)).toBe("$0.01");
  });

  it("shows zero as $0.00", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });
});
