import { fromMarkdown } from "mdast-util-from-markdown";

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
 * Rule 2 alone leaves the shell-variable shapes, where the closing candidate is
 * pinned against punctuation rather than a space (`$HOME/$USER`, `$PATH:$HOME`,
 * `"$USER@$HOST"`). Blacklisting that punctuation is not enough either — every
 * operator has to be listed, and `$FOO+$BAR`, `$A*$B`, `$FOO^$BAR` were all
 * missed. The closer is therefore a *whitelist*: a formula ends on a letter,
 * digit, or closing bracket, and nothing else.
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
export function preprocessLaTeX(content: string, isStreaming = false): string {
  // Early return for most common case
  if (!content.includes("$")) return content;

  return promoteInlineMath(escapeCurrency(content, isStreaming), isStreaming);
}

// A `$` that introduces a number — `$5`, `$1,250.50`, `$3.2M` — and is not
// already escaped or part of a `$$` delimiter. A number closed by a `$` is
// excluded: `$42$` is inline math, not a price.
const CURRENCY_REGEX =
  /(?<![\\$])\$(?!\$)(?=\d+(?:,\d{3})*(?:\.\d+)?(?:[KMBkmb])?(?:\s|$|[^a-zA-Z\d$]))/g;

// Pandoc's rule, tightened at both delimiters. Reading the parts:
//   (?<![\\$])\$(?![$\s{])  opener: not escaped, not part of `$$`, non-space
//                           right, and not `${` — that is shell/JS
//                           interpolation (`${a}${b}`, `${HOME}${USER}`)
//   ([^$\n]*?)              body: one line, no `$` — lazy, so pairs stay tight
//   (?<=[A-Za-z0-9)}\]|])   closer: a formula ends on a letter, digit or closing
//                           bracket. A whitelist, because blacklisting operators
//                           kept missing one (`$A*$B`, `$FOO^$BAR`, `$FOO=$BAR`)
//   \$(?![$\da-zA-Z])       closer: not part of `$$`, and not followed by a
//                           digit or letter — `$FOO$BAR` is two variables, not a
//                           formula. Costs the `$n$th` idiom, which is the same
//                           trade VS Code and marked-katex ship.
// The opener lookahead also makes an empty body impossible: an empty body puts
// a `$` immediately to the opener's right, which `(?![$\s{])` rejects.
const INLINE_MATH_REGEX =
  /(?<![\\$])\$(?![$\s{])([^$\n]*?)(?<=[A-Za-z0-9)}\]|])\$(?![$\da-zA-Z])/g;

const DOUBLE_DOLLAR_REGEX = /\$\$/g;

function escapeCurrency(content: string, isStreaming: boolean): string {
  const codeRegions = findCodeRegions(content, isStreaming);
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
function promoteInlineMath(content: string, isStreaming: boolean): string {
  const codeRegions = findCodeRegions(content, isStreaming);
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
 * Code regions that must not be rewritten, as ascending disjoint [start, end]
 * pairs.
 *
 * Two implementations, because the cost profiles are opposite. A finished reply
 * is parsed properly: CommonMark is the only thing that agrees with the renderer
 * about what a fence, an indented block or a backtick run actually is, and a
 * hand-rolled scanner kept getting it wrong. A streaming reply is scanned,
 * because `children` changes on every token and re-parsing the whole string each
 * time is quadratic — 6.6ms per update and 35s cumulative on a 21k-char reply.
 *
 * The invariant is asymmetric, and that is what makes it safe: everything the
 * renderer treats as code, this must also treat as code. The reverse is allowed.
 * Over-protecting only declines a rewrite, which leaves the literal text the
 * model wrote. Under-protecting rewrites inside a code block, which is the one
 * failure a developer tool cannot have.
 *
 * The consequence is that a code region arriving mid-stream can render as math
 * for as long as it is still streaming, then correct itself when the reply
 * finishes and the parse takes over.
 */
function findCodeRegions(
  content: string,
  isStreaming: boolean,
): Array<[number, number]> {
  return normalizeRegions(
    isStreaming ? scanCodeRegions(content) : parseCodeRegions(content),
  );
}

/** Offsets of every `code` and `inlineCode` node, from a real CommonMark parse. */
function parseCodeRegions(content: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];

  const visit = (node: {
    type: string;
    position?: unknown;
    children?: unknown;
  }) => {
    if (node.type === "code" || node.type === "inlineCode") {
      const position = node.position as
        | { start?: { offset?: number }; end?: { offset?: number } }
        | undefined;
      const start = position?.start?.offset;
      const end = position?.end?.offset;
      if (typeof start === "number" && typeof end === "number") {
        regions.push([start, end]);
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };

  visit(fromMarkdown(content));

  return regions;
}

/**
 * Backtick/tilde scan for the streaming path, deliberately over-inclusive.
 *
 * Runs are matched by length, so a ``` ``span`` ``` is not closed by the second
 * backtick of its own opener, and a ```` ```` ```` fence is not closed by an
 * inner ``` ``` ```. An unterminated run extends to the end of the string:
 * mid-stream that is the normal state of a code block, and CommonMark says an
 * unclosed fence runs to the end of the document anyway.
 */
function scanCodeRegions(content: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let index = 0;
  let fenceStart = -1;
  let fenceChar = "";
  let fenceLength = 0;

  while (index < content.length) {
    const char = content[index];

    if (char !== "`" && char !== "~") {
      index++;
      continue;
    }

    let length = 0;
    while (content[index + length] === char) length++;

    if (fenceStart !== -1) {
      // Only the same character, at least as long, closes an open fence.
      if (char === fenceChar && length >= fenceLength) {
        regions.push([fenceStart, index + length]);
        fenceStart = -1;
      }
      index += length;
      continue;
    }

    if (length >= 3) {
      fenceStart = index;
      fenceChar = char;
      fenceLength = length;
      index += length;
      continue;
    }

    // A backtick run of one or two opens an inline span, closed by a run of the
    // same length. Tildes below three are strikethrough, not code.
    if (char === "~") {
      index += length;
      continue;
    }

    const close = findRunOfLength(content, index + length, length);
    if (close === -1) {
      regions.push([index, content.length]);
      break;
    }
    regions.push([index, close + length]);
    index = close + length;
  }

  if (fenceStart !== -1) regions.push([fenceStart, content.length]);

  return regions;
}

/** First backtick run of exactly `length` at or after `from`, else -1. */
function findRunOfLength(
  content: string,
  from: number,
  length: number,
): number {
  for (let index = from; index < content.length; index++) {
    if (content[index] !== "`") continue;

    let run = 0;
    while (content[index + run] === "`") run++;

    if (run === length) return index;
    index += run - 1;
  }

  return -1;
}

/**
 * Sort and merge, because `isInCodeBlock` binary-searches.
 *
 * Both finders can emit out of order — the scanner when it flushes an open fence
 * at the end, the parser because an `inlineCode` node is visited after the block
 * that follows it in a different branch. An unsorted array silently makes the
 * search miss regions, which reads as "protection is on" while nothing is
 * protected.
 */
function normalizeRegions(
  regions: Array<[number, number]>,
): Array<[number, number]> {
  if (regions.length < 2) return regions;

  const sorted = [...regions].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];

  for (const [start, end] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  return merged;
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
