import { describe, expect, it } from "vitest";
import { isValidModelPrice, normalizeModelPrice } from "./model-price";

describe("isValidModelPrice", () => {
  it.each([
    "0",
    "0.25",
    ".5",
    "1.",
    " 2.50 ",
    "+3",
    "1e-2",
    "99999999.99",
  ])("accepts a complete decimal price: %s", (value) =>
    expect(isValidModelPrice(value)).toBe(true));

  it.each([
    "0,25",
    "1usd",
    "1.2.3",
    "1e",
    "",
    " ",
    "-0.01",
    "NaN",
    "Infinity",
    "1e999",
    "100000000",
    "99999999.990000001",
    "-1e-999",
    "0xff",
    "0b10",
    "1_000",
  ])("rejects invalid or unrepresentable prices: %s", (value) => {
    expect(isValidModelPrice(value)).toBe(false);
  });
});

describe("normalizeModelPrice", () => {
  it.each([
    ["0", "0.00000000"],
    ["-0.0", "0.00000000"],
    ["0.006", "0.00600000"],
    ["0.00000001", "0.00000001"],
    ["0.0000000049", "0.00000000"],
    ["0.000000005", "0.00000001"],
    ["1.000000005", "1.00000001"],
    ["9.999999995", "10.00000000"],
    ["99999999.98999999", "99999999.98999999"],
    ["99999999.989999995", "99999999.99000000"],
    ["99999999.99", "99999999.99000000"],
    ["  +000.123456785  ", "0.12345679"],
    [".5", "0.50000000"],
    ["1.", "1.00000000"],
    ["15e-9", "0.00000002"],
    ["1.23456785E+1", "12.34567850"],
    ["1e-99999999999999999999", "0.00000000"],
    ["0e99999999999999999999", "0.00000000"],
  ])("normalizes %s without binary rounding", (value, expected) => {
    expect(normalizeModelPrice(value)).toBe(expected);
    expect(normalizeModelPrice(expected)).toBe(expected);
  });

  it.each([
    "99999999.990000001",
    "100000000",
    "-1e-999",
    "1e99999999999999999999",
    "1usd",
    "NaN",
    "Infinity",
    "",
    "0xff",
    "1e",
    "1.2.3",
  ])("does not normalize invalid input %s", (value) => {
    expect(normalizeModelPrice(value)).toBeNull();
  });
});
