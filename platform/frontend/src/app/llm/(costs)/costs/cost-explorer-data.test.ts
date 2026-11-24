// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatCell } from "./cost-explorer-data";

describe("formatCell", () => {
  it.each([
    [0.002673, "$0.0027"],
    [0.000668, "$0.00067"],
    [0.01, "$0.01"],
    [4.5, "$4.50"],
    [42.4, "$42"],
  ])("shows %s of spend as %s", (spend, shown) => {
    expect(formatCell("billed", spend)).toBe(shown);
  });

  it("keeps sub-cent axis ticks distinct", () => {
    const ticks = [0.001, 0.002, 0.003].map((v) => formatCell("billed", v));

    expect(new Set(ticks).size).toBe(ticks.length);
  });
});
