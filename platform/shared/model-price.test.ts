import { describe, expect, it } from "vitest";
import { isValidModelPrice } from "./model-price";

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
    "0xff",
    "0b10",
    "1_000",
  ])("rejects invalid or unrepresentable prices: %s", (value) => {
    expect(isValidModelPrice(value)).toBe(false);
  });
});
