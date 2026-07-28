import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./normalize-math";

describe("normalizeMathDelimiters", () => {
  it.each([
    ["inline brackets", "\\( x^2 \\)", "$$x^2$$"],
    ["inline brackets mid-sentence", "so \\(a^2\\) holds", "so $$a^2$$ holds"],
    ["double-escaped inline", "\\\\(a^2\\\\)", "$$a^2$$"],
    ["double-escaped display", "\\\\[a^2\\\\]", "$$\na^2\n$$"],
    ["display on its own line", "\\[ x^2 \\]", "$$\nx^2\n$$"],
    [
      "display alone between paragraphs",
      "Before\n\n\\[ x^2 \\]\n\nAfter",
      "Before\n\n$$\nx^2\n$$\n\nAfter",
    ],
    ["multiline display body", "\\[\nx = y\n\\]", "$$\nx = y\n$$"],
    ["several spans in one line", "\\(a\\) and \\(b\\)", "$$a$$ and $$b$$"],
  ])("rewrites %s", (_label, input, expected) => {
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  // Display math injects newlines at column 0, which would terminate the
  // enclosing block unless the delimiters already own a whole unindented line.
  it("keeps display math inline when it shares a line with other content", () => {
    expect(normalizeMathDelimiters("- item \\[x^2\\]")).toBe("- item $$x^2$$");
  });

  it("keeps display math inline inside a blockquote", () => {
    expect(normalizeMathDelimiters("> note \\[x^2\\]")).toBe("> note $$x^2$$");
  });

  // Indentation is the case the two above miss: the delimiters do sit alone on
  // their line, but the rewrite cannot reproduce the indent, so the body and
  // closer would land outside the list item.
  it("keeps display math inline on an indented list-continuation line", () => {
    expect(
      normalizeMathDelimiters("1. First:\n\n   \\[ x^2 \\]\n\n2. Second"),
    ).toBe("1. First:\n\n   $$x^2$$\n\n2. Second");
  });

  it.each([
    ["a fenced code block", "```js\nconst a = \\[x\\];\n```"],
    ["a fence with no language", "```\n\\( x \\)\n```"],
    ["an inline code span", "use `\\[x\\]` to escape"],
    ["an unclosed fence mid-stream", "```py\nre.match(r'\\[x\\]')"],
    ["a markdown link", "[docs](https://example.com/a)"],
    ["prose with prices", "costs $5 and $10 total"],
    ["text with no math at all", "just a sentence"],
    ["empty brackets", "\\[\\]"],
    ["whitespace-only brackets", "\\[ \\]"],
  ])("leaves %s unchanged", (_label, input) => {
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  // Bracket forms are LaTeX-internal syntax inside a formula; a `$$` region is
  // already in the delimiters remark-math parses and must not be re-scanned.
  it("does not rewrite bracket syntax inside existing $$ math", () => {
    const input = "$$\n\\begin{array}{c} a \\\\[2pt] b \\end{array}\n$$";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it("rewrites bracket math that follows a code block", () => {
    expect(normalizeMathDelimiters("```\n\\[a\\]\n```\n\n\\[ b \\]")).toBe(
      "```\n\\[a\\]\n```\n\n$$\nb\n$$",
    );
  });

  it("returns the original reference when there is nothing to rewrite", () => {
    const input = "no math here";
    expect(normalizeMathDelimiters(input)).toBe(input);
  });
});
