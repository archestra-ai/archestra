import { describe, expect, it } from "vitest";
import { formatContextLength } from "./format-context-length";

describe("formatContextLength", () => {
  it("renders sub-thousand values verbatim", () => {
    expect(formatContextLength(512)).toBe("512");
  });

  it("renders thousands with a K suffix", () => {
    expect(formatContextLength(200_000)).toBe("200K");
    expect(formatContextLength(262_144)).toBe("262.1K");
  });

  it("renders millions with an M suffix", () => {
    expect(formatContextLength(2_000_000)).toBe("2M");
    expect(formatContextLength(1_100_000)).toBe("1.1M");
  });

  it("drops a trailing .0 so values render consistently", () => {
    // 1_000_000 and 1_048_576 must both read as "1M", not "1M" vs "1.0M".
    expect(formatContextLength(1_000_000)).toBe("1M");
    expect(formatContextLength(1_048_576)).toBe("1M");
  });

  it("renders a dash for unknown context length", () => {
    expect(formatContextLength(null)).toBe("-");
    expect(formatContextLength(undefined)).toBe("-");
  });
});
