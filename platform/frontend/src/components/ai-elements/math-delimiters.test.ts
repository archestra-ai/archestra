import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./math-delimiters";

describe("normalizeMathDelimiters", () => {
  it("turns \\[…\\] on its own line into a fenced display block", () => {
    expect(normalizeMathDelimiters("\\[ x^2 \\]")).toBe("$$\nx^2\n$$");
  });

  it("keeps a display block's indentation so it stays in its list item", () => {
    expect(normalizeMathDelimiters("1. a\n\n   \\[\n   x\n   \\]\n")).toBe(
      "1. a\n\n   $$\n   x\n   $$\n",
    );
  });

  it("keeps \\[…\\] inside a sentence inline", () => {
    expect(normalizeMathDelimiters("so \\[x\\] holds")).toBe("so $$x$$ holds");
  });

  it("turns a one-line $$…$$ that owns its line into a display block", () => {
    expect(normalizeMathDelimiters("$$x$$")).toBe("$$\nx\n$$");
  });

  it("turns \\(…\\) and $…$ into inline $$…$$", () => {
    expect(normalizeMathDelimiters("a \\( x \\) b $y$.")).toBe(
      "a $$x$$ b $$y$$.",
    );
  });

  it("leaves an escaped dollar alone", () => {
    expect(normalizeMathDelimiters("\\$x\\$")).toBe("\\$x\\$");
  });

  it("does not pair dollars across lines", () => {
    expect(normalizeMathDelimiters("$a\nb$")).toBe("$a\nb$");
  });

  it("leaves an unclosed delimiter for the rest of the stream", () => {
    expect(normalizeMathDelimiters("so \\[ x = ")).toBe("so \\[ x = ");
    expect(normalizeMathDelimiters("so $$ x = ")).toBe("so $$ x = ");
  });

  it("leaves a fence that is still streaming in untouched", () => {
    const streaming = "Text $x$\n\n```sh\necho $HOME$";
    expect(normalizeMathDelimiters(streaming)).toBe(
      "Text $$x$$\n\n```sh\necho $HOME$",
    );
  });

  it("matches a code span by its backtick run length", () => {
    expect(normalizeMathDelimiters("``a ` $x$`` $y$")).toBe(
      "``a ` $x$`` $$y$$",
    );
  });
});
