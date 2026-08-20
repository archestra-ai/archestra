import { describe, expect, it } from "vitest";
import { formatThousands } from "./format-thousands";

describe("formatThousands", () => {
  it("groups a whole number into thousands", () => {
    expect(formatThousands(128_000)).toBe("128,000");
    expect(formatThousands("8192")).toBe("8,192");
    expect(formatThousands(10_000_000)).toBe("10,000,000");
  });

  it("leaves values below a thousand alone", () => {
    expect(formatThousands(512)).toBe("512");
    expect(formatThousands("1")).toBe("1");
  });

  it("renders an empty field as empty rather than NaN", () => {
    expect(formatThousands("")).toBe("");
    expect(formatThousands("   ")).toBe("");
  });

  it("re-groups an already-formatted number, so pasting one works", () => {
    expect(formatThousands("128,000")).toBe("128,000");
  });
});
