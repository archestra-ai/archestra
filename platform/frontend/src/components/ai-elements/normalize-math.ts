import {
  findCodeRegions,
  findDisplayDelimiters,
  mergeRegions,
  overlapsRegion,
  type Region,
  toDisplayMathRegions,
} from "./markdown-regions";

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
 *
 * `protectedRegions` are the spans a rewrite must not touch — code, and existing
 * `$$` math whose LaTeX-internal syntax (`\\[2pt]` in an array environment) is
 * not a delimiter. `prepareMathDelimiters` passes the ones it already computed;
 * callers without a set get an equivalent one built here. A match is declined if
 * it *overlaps* a region rather than merely starting inside one, because a `\[`
 * in prose pairs lazily with the next `\]`, which may sit past a whole fence.
 */
export function normalizeMathDelimiters(
  text: string,
  protectedRegions?: Region[],
): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;

  const regions = protectedRegions ?? findProtectedRegions(text);

  return text.replace(
    BRACKET_MATH,
    (match, display, inline, offset: number) => {
      const end = offset + match.length;
      if (overlapsRegion(offset, end, regions)) return match;

      const body = (display ?? inline).trim();
      if (body === "") return match;

      if (inline !== undefined) return `$$${body}$$`;

      // Display math earns its own lines only when it already owns an
      // unindented one. The injected newlines land at column 0, so applying
      // this to an indented line — a list-item continuation — would drop the
      // body and the closing `$$` out of the list and swallow whatever follows
      // into the math block. Indented and shares-a-line both fall to inline.
      return occupiesWholeUnindentedLine(text, offset, end)
        ? `$$\n${body}\n$$`
        : `$$${body}$$`;
    },
  );
}

// `\\{1,2}` accepts both `\(` and `\\(` — models emit either, depending on how
// they escape.
const BRACKET_MATH =
  /\\{1,2}\[([\s\S]+?)\\{1,2}\]|\\{1,2}\(([^\n]+?)\\{1,2}\)/g;

function findProtectedRegions(text: string): Region[] {
  const codeRegions = findCodeRegions(text, false);
  const displayMath = toDisplayMathRegions(
    findDisplayDelimiters(text, codeRegions),
  );

  return mergeRegions([...codeRegions, ...displayMath]);
}

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
