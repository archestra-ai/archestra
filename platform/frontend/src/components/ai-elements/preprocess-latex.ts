/**
 * Currency-safe single-dollar math, vendored from LibreChat.
 *
 * Source: https://github.com/danny-avila/LibreChat — client/src/utils/latex.ts
 * MIT License, Copyright (c) Danny Avila.
 *
 * Models emit inline math as `$x$` far more often than as `\(x\)`, but
 * `singleDollarTextMath` has to stay off or "$5 and $10" becomes a formula. The
 * way out is ordering, not a smarter delimiter rule: detect currency
 * *positively* (a `$` that introduces digits) and escape it, then treat every
 * `$…$` still standing as math and promote it to `$$…$$`. Prices are the
 * identifiable case; math is the remainder.
 *
 * Complements `normalize-math.ts`, which covers the bracket forms LibreChat
 * does not handle. Run this first: it works on the original text, and the `$$`
 * regions it produces are then protected by normalize-math's own scan.
 */
export function preprocessLaTeX(content: string): string {
  // Early return for most common case
  if (!content.includes("$")) return content;

  // Process mhchem first (usually rare, so check if needed)
  let processed = content;
  if (content.includes("\\ce{") || content.includes("\\pu{")) {
    processed = escapeMhchem(content);
  }

  // Find all code block regions once
  const codeRegions = findCodeBlockRegions(processed);

  // First pass: escape currency dollar signs
  const parts: string[] = [];
  let lastIndex = 0;

  CURRENCY_REGEX.lastIndex = 0;

  let match = CURRENCY_REGEX.exec(processed);
  while (match !== null) {
    if (!isInCodeBlock(match.index, codeRegions)) {
      parts.push(processed.substring(lastIndex, match.index));
      parts.push("\\$");
      lastIndex = match.index + 1;
    }
    match = CURRENCY_REGEX.exec(processed);
  }
  parts.push(processed.substring(lastIndex));
  processed = parts.join("");

  // Second pass: convert single dollar delimiters to double dollars. Regions
  // are recomputed because the currency pass shifted every offset after the
  // first `\$` it inserted.
  const regionsAfterCurrency = findCodeBlockRegions(processed);
  const result: string[] = [];
  lastIndex = 0;

  SINGLE_DOLLAR_REGEX.lastIndex = 0;

  match = SINGLE_DOLLAR_REGEX.exec(processed);
  while (match !== null) {
    if (!isInCodeBlock(match.index, regionsAfterCurrency)) {
      result.push(processed.substring(lastIndex, match.index));
      result.push(`$$${match[1]}$$`);
      lastIndex = match.index + match[0].length;
    }
    match = SINGLE_DOLLAR_REGEX.exec(processed);
  }
  result.push(processed.substring(lastIndex));

  return result.join("");
}

// A `$` that introduces a number — `$5`, `$1,250.50`, `$3.2M` — and is not
// already escaped or part of a `$$` delimiter.
const CURRENCY_REGEX =
  /(?<![\\$])\$(?!\$)(?=\d+(?:,\d{3})*(?:\.\d+)?(?:[KMBkmb])?(?:\s|$|[^a-zA-Z\d]))/g;

// A `$…$` span that survived the currency pass. `[^$\n]` keeps it on one line
// and stops it swallowing a neighbouring `$$`; the trailing lookbehinds reject
// an escaped or code-adjacent closer.
const SINGLE_DOLLAR_REGEX =
  /(?<!\\)\$(?!\$)((?:[^$\n]|\\[$])+?)(?<!\\)(?<!`)\$(?!\$)/g;

/**
 * Escapes mhchem package notation in LaTeX by converting single dollar
 * delimiters to double dollars and escaping backslashes in mhchem commands.
 */
function escapeMhchem(text: string): string {
  let result = text.replace(MHCHEM_CE_REGEX, "$\\\\ce{");
  result = result.replace(MHCHEM_PU_REGEX, "$\\\\pu{");
  result = result.replace(MHCHEM_CE_ESCAPED_REGEX, (match) => `$${match}$`);
  result = result.replace(MHCHEM_PU_ESCAPED_REGEX, (match) => `$${match}$`);
  return result;
}

const MHCHEM_CE_REGEX = /\$\\ce\{/g;
const MHCHEM_PU_REGEX = /\$\\pu\{/g;
const MHCHEM_CE_ESCAPED_REGEX = /\$\\\\ce\{[^}]*\}\$/g;
const MHCHEM_PU_ESCAPED_REGEX = /\$\\\\pu\{[^}]*\}\$/g;

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
