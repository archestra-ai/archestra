import { describe, expect, it } from "vitest";
import { isUsableTerminalDimensions } from "./exec-terminal.utils";

describe("isUsableTerminalDimensions", () => {
  it("rejects the non-finite dimensions xterm can emit before layout", () => {
    expect(
      isUsableTerminalDimensions({ cols: Number.NaN, rows: Number.NaN }),
    ).toBe(false);
    expect(
      isUsableTerminalDimensions({
        cols: Number.POSITIVE_INFINITY,
        rows: 24,
      }),
    ).toBe(false);
  });

  it("accepts positive integer terminal dimensions", () => {
    expect(isUsableTerminalDimensions({ cols: 120, rows: 40 })).toBe(true);
  });
});
