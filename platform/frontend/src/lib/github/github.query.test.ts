import { describe, expect, it } from "vitest";
import { formatStarCount } from "./github.query";

describe("formatStarCount", () => {
  it("returns the full number for counts under 1000", () => {
    expect(formatStarCount(0)).toBe("0");
    expect(formatStarCount(1)).toBe("1");
    expect(formatStarCount(42)).toBe("42");
    expect(formatStarCount(999)).toBe("999");
  });

  it("returns shorthand for exactly 1000", () => {
    expect(formatStarCount(1000)).toBe("1k");
  });

  it("returns shorthand with one decimal for counts over 1000", () => {
    expect(formatStarCount(1200)).toBe("1.2k");
    expect(formatStarCount(2500)).toBe("2.5k");
    expect(formatStarCount(2720)).toBe("2.7k");
  });

  it("drops trailing zero after decimal", () => {
    expect(formatStarCount(2000)).toBe("2k");
    expect(formatStarCount(5000)).toBe("5k");
    expect(formatStarCount(10000)).toBe("10k");
  });

  it("handles tens of thousands", () => {
    expect(formatStarCount(12700)).toBe("12.7k");
    expect(formatStarCount(15000)).toBe("15k");
    expect(formatStarCount(99900)).toBe("99.9k");
  });

  it("handles hundreds of thousands", () => {
    expect(formatStarCount(100000)).toBe("100k");
    expect(formatStarCount(123400)).toBe("123.4k");
    expect(formatStarCount(500000)).toBe("500k");
  });
});
