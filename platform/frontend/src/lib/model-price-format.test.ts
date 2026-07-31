import { describe, expect, test } from "vitest";
import { formatPricePerMillion } from "./model-price-format";

describe("formatPricePerMillion", () => {
  test("pads a price the API sends without trailing zeros", () => {
    expect(formatPricePerMillion("2.5")).toBe("2.50");
    expect(formatPricePerMillion("10")).toBe("10.00");
    expect(formatPricePerMillion("0")).toBe("0.00");
  });

  test("keeps the decimals of a sub-cent price rather than rounding it away", () => {
    // Rounded to two decimals these read as 0.04 and 0.01, overstating both.
    expect(formatPricePerMillion("0.035")).toBe("0.035");
    expect(formatPricePerMillion("0.00875")).toBe("0.00875");
  });

  test("does not round a price below half a cent down to free", () => {
    expect(formatPricePerMillion("0.004")).toBe("0.004");
    expect(formatPricePerMillion("0.0001")).toBe("0.0001");
  });

  test("reads a price the API sent in exponential form", () => {
    expect(formatPricePerMillion("1e-7")).toBe("0.0000001");
  });

  test("leaves a value it cannot parse alone", () => {
    expect(formatPricePerMillion("")).toBe("");
    expect(formatPricePerMillion("n/a")).toBe("n/a");
  });
});
