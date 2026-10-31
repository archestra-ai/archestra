// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  formatMediaPricing,
  formatPricePerMillion,
} from "./model-price-format";

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

  test("preserves distinct eight-decimal prices near the maximum", () => {
    expect(formatPricePerMillion("99999999.98999997")).toBe(
      "99999999.98999997",
    );
    expect(formatPricePerMillion("99999999.98999998")).toBe(
      "99999999.98999998",
    );
  });

  test("leaves a value it cannot parse alone", () => {
    expect(formatPricePerMillion("")).toBe("");
    expect(formatPricePerMillion("n/a")).toBe("n/a");
  });
});

describe("formatMediaPricing", () => {
  test("names each image-token rate by what it meters", () => {
    expect(
      formatMediaPricing({
        per: "million_tokens",
        input: [
          { kind: "text", usd: 5 },
          { kind: "image", usd: 10 },
        ],
        output: [{ kind: "image", usd: 40 }],
      }),
    ).toBe("$5.00 text · $10.00 image / $40.00 image");
  });

  test("leaves a rate shared by text and image input unnamed", () => {
    expect(
      formatMediaPricing({
        per: "million_tokens",
        input: [{ kind: "text_and_image", usd: 0.3 }],
        output: [
          { kind: "image", usd: 30 },
          { kind: "text", usd: 2.5 },
        ],
      }),
    ).toBe("$0.30 / $30.00 image · $2.50 text");
  });

  test("shows speech per character and transcription per minute", () => {
    expect(
      formatMediaPricing({
        per: "million_characters",
        input: [{ kind: "text", usd: 15 }],
        output: [],
      }),
    ).toBe("$15.00 / 1M chars");
    expect(
      formatMediaPricing({
        per: "minute",
        input: [{ kind: "audio", usd: 0.006 }],
        output: [],
      }),
    ).toBe("$0.006 / min");
  });
});
