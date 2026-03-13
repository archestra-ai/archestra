import { describe, expect, it } from "vitest";

import { computeHandlebarsReplaceOffsets } from "./handlebars-completion";

describe("computeHandlebarsReplaceOffsets", () => {
  it("returns zero offsets when no braces around cursor", () => {
    expect(computeHandlebarsReplaceOffsets("Hello ", "world")).toEqual({
      startOffset: 0,
      endOffset: 0,
    });
  });

  it("detects single opening brace before cursor", () => {
    expect(computeHandlebarsReplaceOffsets("Hello {", "")).toEqual({
      startOffset: 1,
      endOffset: 0,
    });
  });

  it("detects double opening braces before cursor", () => {
    expect(computeHandlebarsReplaceOffsets("Hello {{", "")).toEqual({
      startOffset: 2,
      endOffset: 0,
    });
  });

  it("detects closing braces after cursor", () => {
    expect(computeHandlebarsReplaceOffsets("Hello {{", "}}")).toEqual({
      startOffset: 2,
      endOffset: 2,
    });
  });

  it("detects single closing brace after cursor", () => {
    expect(computeHandlebarsReplaceOffsets("{", "}")).toEqual({
      startOffset: 1,
      endOffset: 1,
    });
  });

  it("handles partial expression typed before cursor", () => {
    expect(computeHandlebarsReplaceOffsets("{{cur", "}}")).toEqual({
      startOffset: 0,
      endOffset: 2,
    });
  });

  it("handles braces only before cursor with trailing text", () => {
    expect(computeHandlebarsReplaceOffsets("{{", "some text")).toEqual({
      startOffset: 2,
      endOffset: 0,
    });
  });

  it("handles empty strings", () => {
    expect(computeHandlebarsReplaceOffsets("", "")).toEqual({
      startOffset: 0,
      endOffset: 0,
    });
  });

  it("does not count braces that are not adjacent to cursor", () => {
    expect(computeHandlebarsReplaceOffsets("{{ hello {", "} world }}")).toEqual(
      {
        startOffset: 1,
        endOffset: 1,
      },
    );
  });

  it("handles triple braces before cursor", () => {
    expect(computeHandlebarsReplaceOffsets("{{{", "")).toEqual({
      startOffset: 3,
      endOffset: 0,
    });
  });
});
