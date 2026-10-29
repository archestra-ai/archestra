// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatCompactNumber } from "./format-compact-number";

describe("formatCompactNumber", () => {
  it("leaves counts below a thousand whole", () => {
    expect(formatCompactNumber(0)).toBe("0");
    expect(formatCompactNumber(999)).toBe("999");
  });

  it("abbreviates thousands, millions and billions to one decimal", () => {
    expect(formatCompactNumber(1_000)).toBe("1K");
    expect(formatCompactNumber(1_050)).toBe("1.1K");
    expect(formatCompactNumber(100_000)).toBe("100K");
    expect(formatCompactNumber(129_984)).toBe("130K");
    expect(formatCompactNumber(1_000_000)).toBe("1M");
    expect(formatCompactNumber(2_500_000_000)).toBe("2.5B");
  });
});
