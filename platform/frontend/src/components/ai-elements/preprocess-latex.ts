/**
 * Currency-safe single-dollar math.
 *
 * Models emit inline math as `$x$` far more often than as `\(x\)`, but
 * `singleDollarTextMath` has to stay off or "$5 and $10" becomes a formula.
 * remark-math only ever sees `$$`, so this pass decides which `$…$` spans are
 * math and promotes those. The direction matters: promoting a detected span
 * fails *safe* — a span we decline to promote is simply shown as the literal
 * text the model wrote. Enabling `singleDollarTextMath` and escaping the
 * non-math spans instead would fail the other way, where every span we failed
 * to recognise becomes a formula.
 *
 * Two rules decide, in order:
 *
 * 1. Currency is detected *positively* — a `$` that introduces digits — and
 *    escaped, so it can no longer act as a delimiter. (Kept from LibreChat's
 *    latex.ts, MIT, Copyright (c) Danny Avila.)
 * 2. What is left is promoted only if it satisfies Pandoc's delimiter rule:
 *    the opening `$` needs a non-space to its right, the closing `$` a
 *    non-space to its left, and the closing `$` may not be followed by a
 *    digit. That rule exists for exactly this problem — it is what makes
 *    "$20,000 and $30,000" not parse as math — and is the same default
 *    markdown-it-dollarmath ships as `allow_space: false` / `allow_digits:
 *    false`.
 *
 * Rule 2 alone leaves the shell-variable shapes, where the closing candidate
 * is pinned against punctuation rather than a space (`$HOME/$USER`,
 * `$PATH:$HOME`, `"$USER@$HOST"`), so the closer additionally rejects the path
 * and list punctuation that no inline formula ends on.
 *
 * Complements `normalize-math.ts`, which covers the bracket forms. Run this
 * first: it works on the original text, and the `$$` regions it produces are
 * then protected by normalize-math's own scan.
 *
 * Upstream's mhchem branch is deliberately not vendored. It rewrites `$\ce{…}$`
 * to `$$\\ce{…}$$`, and KaTeX reads that doubled backslash as a line break, so
 * the formula came out as bare letters ("ceH2O") that read as content. Nothing
 * loads `katex/contrib/mhchem` here either, so `\ce` is an undefined control
 * sequence either way — but left intact it renders as `\ce` in the plugin's
 * errorColor, which at least reads as a command that failed.
 */
export function preprocessLaTeX(content: string): string {
  // Early return for most common case
  if (!content.includes("$")) return content;

  return promoteInlineMath(escapeCurrency(content));
}

// A `$` that introduces a number — `$5`, `$1,250.50`, `$3.2M` — and is not
// already escaped or part of a `$$` delimiter. A number closed by a `$` is
// excluded: `$42$` is inline math, not a price.
const CURRENCY_REGEX =
  /(?<![\\$])\$(?!\$)(?=\d+(?:,\d{3})*(?:\.\d+)?(?:[KMBkmb])?(?:\s|$|[^a-zA-Z\d$]))/g;

// Pandoc's rule, plus the punctuation guard. Reading the parts:
//   (?<![\\$])\$(?![$\s])  opener: not escaped, not part of `$$`, non-space right
//   ([^$\n]*?)             body: one line, no `$` — lazy, so pairs stay tight
//   (?<![\s\\/:@|&;,])     closer: non-space left, and not pinned against the
//                          path/list punctuation a formula never ends on
//   \$(?![$\d])            closer: not part of `$$`, not followed by a digit
// The opener lookahead also makes an empty body impossible: an empty body puts
// a `$` immediately to the opener's right, which `(?![$\s])` rejects.
const INLINE_MATH_REGEX =
  /(?<![\\$])\$(?![$\s])([^$\n]*?)(?<![\s\\/:@|&;,])\$(?![$\d])/g;

const DOUBLE_DOLLAR_REGEX = /\$\$/g;

function escapeCurrency(content: string): string {
  const codeRegions = findCodeBlockRegions(content);
  const parts: string[] = [];
  let lastIndex = 0;

  CURRENCY_REGEX.lastIndex = 0;

  let match = CURRENCY_REGEX.exec(content);
  while (match !== null) {
    if (!isInCodeBlock(match.index, codeRegions)) {
      parts.push(content.substring(lastIndex, match.index));
      parts.push("\\$");
      lastIndex = match.index + 1;
    }
    match = CURRENCY_REGEX.exec(content);
  }
  parts.push(content.substring(lastIndex));

  return parts.join("");
}

/**
 * Promote surviving `$…$` spans to `$$…$$`.
 *
 * Regions are recomputed here because the currency pass shifted every offset
 * after the first `\$` it inserted.
 */
function promoteInlineMath(content: string): string {
  const codeRegions = findCodeBlockRegions(content);
  const displayDelimiters = findDisplayDelimiters(content, codeRegions);
  const result: string[] = [];
  let lastIndex = 0;

  INLINE_MATH_REGEX.lastIndex = 0;

  let match = INLINE_MATH_REGEX.exec(content);
  while (match !== null) {
    if (
      !isInCodeBlock(match.index, codeRegions) &&
      !hasOpenDisplayMathBefore(content, match.index, displayDelimiters)
    ) {
      result.push(content.substring(lastIndex, match.index));
      result.push(`$$${match[1]}$$`);
      lastIndex = match.index + match[0].length;
    }
    match = INLINE_MATH_REGEX.exec(content);
  }
  result.push(content.substring(lastIndex));

  return result.join("");
}

/** Offsets of every `$$` outside code, in ascending order. */
function findDisplayDelimiters(
  content: string,
  codeRegions: Array<[number, number]>,
): number[] {
  const positions: number[] = [];

  DOUBLE_DOLLAR_REGEX.lastIndex = 0;

  let match = DOUBLE_DOLLAR_REGEX.exec(content);
  while (match !== null) {
    if (!isInCodeBlock(match.index, codeRegions)) positions.push(match.index);
    match = DOUBLE_DOLLAR_REGEX.exec(content);
  }

  return positions;
}

/**
 * Whether an unclosed `$$` already opened in this paragraph.
 *
 * A promoted pair inserted under an open `$$` gets eaten by it — the opener
 * pairs with our opening `$$` and the prose between them becomes the formula,
 * so "Save $$ when $x$ is high" rendered as "Save whenwhenwhenx$$ is high".
 * Escaping the stray `$$` instead would cost more than it saves: an unclosed
 * `$$` is the normal state of display math that is still streaming, and it
 * renders progressively today (micromark closes math flow at end of input) —
 * escaping it would hold the formula as raw text until its closer arrived.
 * Declining to promote is the fail-safe half: the span stays literal.
 *
 * Scoped to the paragraph because that is as far as remark-math will pair a
 * text-math delimiter, and it keeps an open display block from suppressing
 * promotion in the rest of the reply.
 */
function hasOpenDisplayMathBefore(
  content: string,
  index: number,
  displayDelimiters: number[],
): boolean {
  const paragraphStart = content.lastIndexOf("\n\n", index) + 1;
  let count = 0;

  for (const position of displayDelimiters) {
    if (position >= index) break;
    if (position >= paragraphStart) count++;
  }

  return count % 2 === 1;
}

/**
 * Code regions that must not be rewritten, as [start, end] pairs.
 *
 * Deviates from upstream in one way: an unterminated fence runs to the end of
 * the string instead of being dropped. Replies are rendered while they stream,
 * so a fence is *routinely* open at render time — upstream's version leaves
 * that half-arrived block unprotected and rewrites the `$` inside it.
 */
function findCodeBlockRegions(content: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let inlineStart = -1;
  let multilineStart = -1;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (
      char === "`" &&
      i + 2 < content.length &&
      content[i + 1] === "`" &&
      content[i + 2] === "`"
    ) {
      if (multilineStart === -1) {
        multilineStart = i;
        i += 2;
      } else {
        regions.push([multilineStart, i + 2]);
        multilineStart = -1;
        i += 2;
      }
    } else if (char === "`" && multilineStart === -1) {
      if (inlineStart === -1) {
        inlineStart = i;
      } else {
        regions.push([inlineStart, i]);
        inlineStart = -1;
      }
    }
  }

  if (multilineStart !== -1) regions.push([multilineStart, content.length]);

  return regions;
}

/** Whether a position falls inside any code region. Regions are ascending. */
function isInCodeBlock(
  position: number,
  codeRegions: Array<[number, number]>,
): boolean {
  let left = 0;
  let right = codeRegions.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const [start, end] = codeRegions[mid];

    if (position >= start && position <= end) {
      return true;
    } else if (position < start) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return false;
}
