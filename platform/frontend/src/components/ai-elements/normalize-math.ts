/**
 * Rewrites the LaTeX bracket delimiters models emit (`\(...\)`, `\[...\]`) to the
 * `$$...$$` delimiters remark-math parses, so chat replies render as notation
 * instead of raw TeX.
 *
 * This has to run on the raw markdown string, before it reaches the parser.
 * CommonMark backslash-escapes ASCII punctuation, so `\( x \)` is already the
 * plain text `( x )` by the time an mdast tree exists — the delimiters are gone
 * and no remark/rehype plugin can recover them.
 *
 * Everything maps to `$$` rather than `$` because single-dollar math stays
 * disabled (`@streamdown/math` defaults `singleDollarTextMath` to false). That
 * keeps prices in prose — "$5 and $10" — from being read as a math span, which
 * is the failure mode that needs currency-detection heuristics elsewhere.
 * remark-math still picks display vs inline from position: `$$` alone on its
 * own lines is display math, `$$` inside a line is inline math.
 */
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;

  return text.replace(
    PROTECTED_OR_BRACKET_MATH,
    (match, protectedRun, display, inline, offset: number) => {
      if (protectedRun !== undefined) return protectedRun;

      const body = (display ?? inline).trim();
      if (body === "") return match;

      if (inline !== undefined) return `$$${body}$$`;

      // Display math earns its own lines only when it already owns an
      // unindented one. The injected newlines land at column 0, so applying
      // this to an indented line — a list-item continuation — would drop the
      // body and the closing `$$` out of the list and swallow whatever follows
      // into the math block. Indented and shares-a-line both fall to inline.
      return occupiesWholeUnindentedLine(text, offset, offset + match.length)
        ? `$$\n${body}\n$$`
        : `$$${body}$$`;
    },
  );
}

// Regions that must survive untouched, then the two bracket forms. The
// protected branch is first so a scan entering a code region consumes the whole
// region and never rewrites the delimiters inside it. It covers the unclosed
// fence that exists mid-stream, and existing `$$` math so that LaTeX-internal
// syntax such as `\\[2pt]` inside a formula is never mistaken for a delimiter.
// `\\{1,2}` accepts both `\(` and `\\(` — models emit either, depending on how
// they escape.
const PROTECTED_OR_BRACKET_MATH =
  /(```[\s\S]*?```|```[\s\S]*$|`[^`\n]*`|\$\$[\s\S]*?\$\$)|\\{1,2}\[([\s\S]+?)\\{1,2}\]|\\{1,2}\(([^\n]+?)\\{1,2}\)/g;

// Nothing but the line break may precede the delimiter — indentation counts as
// content here, because the rewrite cannot reproduce it. Trailing whitespace is
// fine: it does not change where the injected newlines land.
function occupiesWholeUnindentedLine(
  text: string,
  start: number,
  end: number,
): boolean {
  return (
    /(^|\n)$/.test(text.slice(0, start)) &&
    /^[ \t]*(\n|$)/.test(text.slice(end))
  );
}
