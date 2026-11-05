import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * A half-open `[start, end)` range of the source markdown. Region lists are
 * always ascending and disjoint, because the lookups below binary-search.
 */
export type Region = [number, number];

/**
 * Code regions, as ascending disjoint `[start, end)` pairs.
 *
 * Both math passes ask this module the same question, and they used to answer it
 * differently — the dollar pass with a real parse, the bracket pass with a regex
 * that knew only ``` fences and single-backtick spans. That gap rewrote the
 * contents of tilde fences and indented code blocks. One implementation now, so
 * a shape is protected for both passes or for neither.
 *
 * The invariant is asymmetric, and that is what makes it safe: everything the
 * renderer treats as code, this must also treat as code. The reverse is allowed.
 * Over-protecting only declines a rewrite, which leaves the literal text the
 * model wrote. Under-protecting rewrites inside a code block, which is the one
 * failure a developer tool cannot have.
 *
 * Two implementations, because the cost profiles are opposite. A finished reply
 * is parsed properly: CommonMark is the only thing that agrees with the renderer
 * about what a fence, an indented block or a backtick run actually is, and a
 * hand-rolled scanner kept getting it wrong. A streaming reply is scanned,
 * because `children` changes on every token and re-parsing the whole string each
 * time is quadratic — 6.6ms per update and 35s cumulative on a 21k-char reply.
 *
 * The consequence is that a code region arriving mid-stream can render as math
 * for as long as it is still streaming, then correct itself when the reply
 * finishes and the parse takes over. Indented code blocks are the standing case:
 * the scanner has no notion of them, because mid-stream a four-space indent is
 * not distinguishable from a deep list continuation without block context, and
 * guessing would suppress math inside nested list items.
 */
export function findCodeRegions(
  content: string,
  isStreaming: boolean,
): Region[] {
  return mergeRegions(
    isStreaming ? scanCodeRegions(content) : parseCodeRegions(content),
  );
}

/** Offsets of every `$$` outside code, in ascending order. */
export function findDisplayDelimiters(
  content: string,
  codeRegions: Region[],
): number[] {
  const positions: number[] = [];

  DOUBLE_DOLLAR_REGEX.lastIndex = 0;

  let match = DOUBLE_DOLLAR_REGEX.exec(content);
  while (match !== null) {
    if (!isInRegion(match.index, codeRegions)) positions.push(match.index);
    match = DOUBLE_DOLLAR_REGEX.exec(content);
  }

  return positions;
}

/**
 * `$$…$$` pairs as regions, so LaTeX-internal syntax inside a formula — `\\[2pt]`
 * in an array environment — is never mistaken for a delimiter.
 *
 * A trailing unpaired opener is dropped rather than run to the end of the
 * string. Mid-stream that opener is display math still arriving, and protecting
 * everything after it would freeze the rest of the reply for as long as the
 * closer takes to turn up.
 */
export function toDisplayMathRegions(delimiters: number[]): Region[] {
  const regions: Region[] = [];

  for (let index = 0; index + 1 < delimiters.length; index += 2) {
    regions.push([delimiters[index], delimiters[index + 1] + 2]);
  }

  return regions;
}

/**
 * Sort and merge, because the lookups below binary-search.
 *
 * Callers can pass regions out of order — the scanner when it flushes an open
 * fence at the end, the parser because an `inlineCode` node is visited after the
 * block that follows it in a different branch, and any caller concatenating code
 * regions with display-math ones. An unsorted array silently makes the search
 * miss regions, which reads as "protection is on" while nothing is protected.
 */
export function mergeRegions(regions: Region[]): Region[] {
  if (regions.length < 2) return regions;

  const sorted = [...regions].sort((a, b) => a[0] - b[0]);
  const merged: Region[] = [sorted[0]];

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

/** Whether a position falls inside any region. Regions are ascending. */
export function isInRegion(position: number, regions: Region[]): boolean {
  let left = 0;
  let right = regions.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const [start, end] = regions[mid];

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

/**
 * Whether `[start, end)` touches any region.
 *
 * A span, not a point, because a bracket delimiter pair can straddle a region
 * it never enters: an opening `\[` in prose pairs lazily with the next `\]`,
 * which may sit past a whole fenced block. Rewriting that pair would replace
 * the fence's own delimiters along with everything around it.
 */
export function overlapsRegion(
  start: number,
  end: number,
  regions: Region[],
): boolean {
  let left = 0;
  let right = regions.length - 1;
  let candidate = -1;

  // Leftmost region that ends at or after `start`; nothing earlier can overlap.
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);

    if (regions[mid][1] > start) {
      candidate = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return candidate !== -1 && regions[candidate][0] < end;
}

const DOUBLE_DOLLAR_REGEX = /\$\$/g;

/** Offsets of every `code` and `inlineCode` node, from a real CommonMark parse. */
function parseCodeRegions(content: string): Region[] {
  const regions: Region[] = [];

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
function scanCodeRegions(content: string): Region[] {
  const regions: Region[] = [];
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
