import {
  findCodeRegions,
  findDisplayDelimiters,
  isInRegion,
  mergeRegions,
  overlapsRegion,
  type Region,
  toDisplayMathRegions,
} from "./markdown-regions";
import { normalizeMathDelimiters } from "./normalize-math";

/**
 * Rewrites the math delimiters models emit into the `$$…$$` remark-math parses.
 *
 * Three passes, because models emit three shapes and each needs a different
 * trick: prices have to be told apart from dollar math, dollar math has to be
 * told apart from shell variables, and bracket math has to be caught before
 * CommonMark eats its backslashes (normalize-math.ts).
 *
 * Currency first, so it works on the original text. Brackets last, so the `$$`
 * regions the promotion produces are already there to be protected.
 *
 * The passes share one scan of the code regions. Each rewrite moves every offset
 * after it, but both dollar passes only ever *insert* characters, so the regions
 * are remapped rather than found again — see `shiftRegions`. That is worth
 * arranging: on the finished path a region scan is a full CommonMark parse, and
 * asking for one after each pass tripled the cost of a reply using both forms.
 *
 * Currency-safe single-dollar math is the interesting half. Models emit inline
 * math as `$x$` far more often than as `\(x\)`, but `singleDollarTextMath` has
 * to stay off or "$5 and $10" becomes a formula. remark-math only ever sees
 * `$$`, so this decides which `$…$` spans are math and promotes those. The
 * direction matters: promoting a detected span fails *safe* — a span we decline
 * to promote is simply shown as the literal text the model wrote. Enabling
 * `singleDollarTextMath` and escaping the non-math spans instead would fail the
 * other way, where every span we failed to recognise becomes a formula.
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
 * Upstream's mhchem branch is deliberately not vendored. It rewrites `$\ce{…}$`
 * to `$$\\ce{…}$$`, and KaTeX reads that doubled backslash as a line break, so
 * the formula came out as bare letters ("ceH2O") that read as content. Nothing
 * loads `katex/contrib/mhchem` here either, so `\ce` is an undefined control
 * sequence either way — but left intact it renders as `\ce` in the plugin's
 * errorColor, which at least reads as a command that failed.
 */
export function prepareMathDelimiters(
  content: string,
  isStreaming = false,
): string {
  const hasDollarMath = content.includes("$");
  const hasBracketMath = content.includes("\\(") || content.includes("\\[");

  if (!hasDollarMath && !hasBracketMath) return content;

  let text = content;
  let codeRegions = findCodeRegions(text, isStreaming);

  if (hasDollarMath) {
    const escaped = escapeCurrency(text, codeRegions);
    text = escaped.text;
    codeRegions = shiftRegions(codeRegions, escaped.insertions);

    const promoted = promoteInlineMath(text, codeRegions);
    text = promoted.text;
    // Only the bracket pass reads the regions again.
    if (hasBracketMath) {
      codeRegions = shiftRegions(codeRegions, promoted.insertions);
    }
  }

  if (!hasBracketMath) return text;

  const displayMath = toDisplayMathRegions(
    findDisplayDelimiters(text, codeRegions),
  );

  return normalizeMathDelimiters(
    text,
    mergeRegions([...codeRegions, ...displayMath]),
  );
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

/** A character insertion, as an offset in the pre-edit string and its length. */
type Insertion = { at: number; length: number };

type Rewrite = { text: string; insertions: Insertion[] };

function escapeCurrency(content: string, codeRegions: Region[]): Rewrite {
  const parts: string[] = [];
  const insertions: Insertion[] = [];
  let lastIndex = 0;

  CURRENCY_REGEX.lastIndex = 0;

  let match = CURRENCY_REGEX.exec(content);
  while (match !== null) {
    if (!isInRegion(match.index, codeRegions)) {
      parts.push(content.substring(lastIndex, match.index));
      parts.push("\\$");
      insertions.push({ at: match.index, length: 1 });
      lastIndex = match.index + 1;
    }
    match = CURRENCY_REGEX.exec(content);
  }
  parts.push(content.substring(lastIndex));

  return { text: parts.join(""), insertions };
}

/** Promote surviving `$…$` spans to `$$…$$`. */
function promoteInlineMath(content: string, codeRegions: Region[]): Rewrite {
  const displayDelimiters = findDisplayDelimiters(content, codeRegions);
  const result: string[] = [];
  const insertions: Insertion[] = [];
  let lastIndex = 0;

  INLINE_MATH_REGEX.lastIndex = 0;

  let match = INLINE_MATH_REGEX.exec(content);
  while (match !== null) {
    const end = match.index + match[0].length;

    // Overlap, not just the opening `$`: the body may run into a code span the
    // opener sits outside of, and half a rewrite inside a backtick run is the
    // same corruption as a whole one.
    if (
      !overlapsRegion(match.index, end, codeRegions) &&
      !hasOpenDisplayMathBefore(content, match.index, displayDelimiters)
    ) {
      result.push(content.substring(lastIndex, match.index));
      result.push(`$$${match[1]}$$`);
      insertions.push({ at: match.index, length: 1 }, { at: end, length: 1 });
      lastIndex = end;
    }
    match = INLINE_MATH_REGEX.exec(content);
  }
  result.push(content.substring(lastIndex));

  return { text: result.join(""), insertions };
}

/**
 * Move regions from a pre-edit string onto its post-edit one.
 *
 * Both passes above only insert characters, so a boundary moves by the total
 * length inserted at or before it. Cheaper than asking for the regions again:
 * on the finished path that is a full CommonMark parse.
 *
 * Start and end are swept separately because a promotion inserts at both ends
 * of its match. A region enclosed by one — code inside a formula, which is not
 * a thing LaTeX does but is a thing a regex can match — moves by the opening
 * `$` alone, while a region after the match moves by both.
 */
function shiftRegions(regions: Region[], insertions: Insertion[]): Region[] {
  if (insertions.length === 0) return regions;

  const shifted: Region[] = [];
  let index = 0;
  let delta = 0;

  for (const [start, end] of regions) {
    while (index < insertions.length && insertions[index].at <= start) {
      delta += insertions[index].length;
      index++;
    }

    let endIndex = index;
    let endDelta = delta;
    while (endIndex < insertions.length && insertions[endIndex].at <= end) {
      endDelta += insertions[endIndex].length;
      endIndex++;
    }

    shifted.push([start + delta, end + endDelta]);
  }

  return shifted;
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
