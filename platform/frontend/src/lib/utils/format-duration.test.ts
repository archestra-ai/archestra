// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatElapsed, formatLatency } from "./format-duration";

describe("formatLatency", () => {
  it("keeps sub-second calls in milliseconds", () => {
    expect(formatLatency(0)).toBe("0ms");
    expect(formatLatency(386)).toBe("386ms");
  });

  it("shows two decimals under ten seconds and one above", () => {
    expect(formatLatency(1240)).toBe("1.24s");
    expect(formatLatency(18_930)).toBe("18.9s");
  });

  it("switches to minutes past a minute", () => {
    expect(formatLatency(65_000)).toBe("1m 5s");
  });

  it("reads an untimed record as missing, not as zero", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(undefined)).toBe("—");
  });
});

describe("formatElapsed", () => {
  it("names the two largest units", () => {
    expect(formatElapsed(4_200)).toBe("4.2s");
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(185_000)).toBe("3m 5s");
    expect(formatElapsed(2 * 3_600_000 + 10 * 60_000)).toBe("2h 10m");
    expect(formatElapsed(27 * 3_600_000)).toBe("1d 3h");
  });

  it("drops a zero remainder", () => {
    expect(formatElapsed(120_000)).toBe("2m");
    expect(formatElapsed(3_600_000)).toBe("1h");
  });

  it("rounds seconds before carrying into minutes", () => {
    // 1m 59.6s must not read as "1m 60s".
    expect(formatElapsed(119_600)).toBe("2m");
  });

  it("never reads negative", () => {
    expect(formatElapsed(-50)).toBe("0ms");
  });
});
