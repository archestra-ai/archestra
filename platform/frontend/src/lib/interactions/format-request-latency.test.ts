import { describe, expect, it } from "vitest";
import { formatRequestLatency } from "./format-request-latency";

describe("formatRequestLatency", () => {
  it("distinguishes absent historical latency from zero", () => {
    expect(formatRequestLatency(null)).toBe("—");
    expect(formatRequestLatency(undefined)).toBe("—");
    expect(formatRequestLatency(0)).toBe("0 ms");
  });
  it("formats millisecond and second latencies compactly", () => {
    expect(formatRequestLatency(999)).toBe("999 ms");
    expect(formatRequestLatency(1_000)).toBe("1.00 s");
    expect(formatRequestLatency(1_234)).toBe("1.23 s");
    expect(formatRequestLatency(10_000)).toBe("10.0 s");
  });
});
