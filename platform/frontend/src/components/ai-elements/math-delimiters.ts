/**
 * Rewrite the TeX delimiters models emit into the `$$` form remark-math
 * parses with single-dollar math turned off.
 *
 * - `\[…\]` and `$$…$$` that own their line(s) become a display block
 *   (`$$` fences on lines of their own); remark-math renders a one-line
 *   `$$…$$` inline.
 * - `\(…\)` becomes inline `$$…$$`. It has to be rewritten on the raw
 *   string: markdown reads `\(` as an escaped parenthesis, so no remark or
 *   rehype plugin ever sees the delimiter.
 * - `$…$` becomes inline `$$…$$` only when it reads as math under pandoc's
 *   rule (no space just inside either `$`) and the closing `$` is not
 *   followed by a letter or digit. That keeps "$HOME and $PATH",
 *   "$5 and $10" and "$5-$10" as plain text.
 *
 * Code spans and fenced code blocks, including a fence still streaming in,
 * are left untouched.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!MAY_CONTAIN_MATH.test(markdown)) return markdown;
  return splitFencedCode(markdown)
    .map((segment) =>
      segment.code ? segment.text : normalizeOutsideFences(segment.text),
    )
    .join("");
}

// =============================================================================
// Internal helpers
// =============================================================================

const MAY_CONTAIN_MATH = /\$|\\\(|\\\[/;

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

type Segment = { text: string; code: boolean };

function splitFencedCode(markdown: string): Segment[] {
  const lines = markdown.split(/(?<=\n)/);
  const segments: Segment[] = [];
  let buffer = "";
  let fence: string | null = null;

  const flush = (code: boolean) => {
    if (buffer) segments.push({ text: buffer, code });
    buffer = "";
  };

  for (const line of lines) {
    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        flush(false);
        fence = open[1];
      }
      buffer += line;
      continue;
    }
    buffer += line;
    const trimmed = line.trim();
    if (
      trimmed.length >= fence.length &&
      trimmed === fence[0].repeat(trimmed.length)
    ) {
      fence = null;
      flush(true);
    }
  }
  // An unclosed fence is code until the end: it is still streaming in.
  flush(fence !== null);
  return segments;
}

function normalizeOutsideFences(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];

    if (char === "`") {
      const end = inlineCodeEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }

    if (char === "\\" && (text[i + 1] === "[" || text[i + 1] === "(")) {
      const display = text[i + 1] === "[";
      const close = findUnescaped(text, display ? "\\]" : "\\)", i + 2);
      if (close === -1 || (!display && text.slice(i, close).includes("\n"))) {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      const body = text.slice(i + 2, close);
      const end = close + 2;
      out += display
        ? displayMath({ text, start: i, end, body })
        : `$$${body.trim()}$$`;
      i = end;
      continue;
    }

    if (char === "\\") {
      // An escaped character, `\$` included, stays as written.
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (char === "$" && text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      if (close === -1) {
        out += "$$";
        i += 2;
        continue;
      }
      const body = text.slice(i + 2, close);
      const end = close + 2;
      out += body.includes("\n")
        ? text.slice(i, end)
        : displayMath({ text, start: i, end, body });
      i = end;
      continue;
    }

    if (char === "$") {
      const close = singleDollarClose(text, i);
      if (close === -1) {
        out += "$";
        i += 1;
        continue;
      }
      out += `$$${text.slice(i + 1, close)}$$`;
      i = close + 1;
      continue;
    }

    out += char;
    i += 1;
  }
  return out;
}

/**
 * A formula that owns its line becomes a fenced display block, each fence
 * indented like the line so the block stays inside a list item. Anywhere else
 * it stays inline.
 */
function displayMath(params: {
  text: string;
  start: number;
  end: number;
  body: string;
}): string {
  const { text, start, end, body } = params;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const indent = text.slice(lineStart, start);
  const lineEnd = text.indexOf("\n", end);
  const rest = text.slice(end, lineEnd === -1 ? text.length : lineEnd);
  const ownsLine = /^[ \t]*$/.test(indent) && /^[ \t]*$/.test(rest);
  if (!ownsLine) return `$$${body.trim()}$$`;
  const lines = body
    .trim()
    .split("\n")
    .map((line) => `${indent}${line.trim()}`);
  return `$$\n${lines.join("\n")}\n${indent}$$`;
}

/** Index of the `$` closing a single-dollar formula opened at `open`, or -1. */
function singleDollarClose(text: string, open: number): number {
  const first = text[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  // "a$b$" and "US$5" are not formulas.
  if (open > 0 && /[\p{L}\p{N}]/u.test(text[open - 1])) return -1;
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\n") return -1;
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char !== "$") continue;
    const before = text[i - 1];
    const after = text[i + 1] ?? "";
    if (/\s/.test(before) || after === "$") return -1;
    if (/[\p{L}\p{N}]/u.test(after)) return -1;
    return i;
  }
  return -1;
}

/** Index just past the code span opened at `start`, or past its backticks. */
function inlineCodeEnd(text: string, start: number): number {
  let runEnd = start;
  while (text[runEnd] === "`") runEnd += 1;
  const run = runEnd - start;
  let i = runEnd;
  while (i < text.length) {
    const next = text.indexOf("`", i);
    if (next === -1) break;
    let closeEnd = next;
    while (text[closeEnd] === "`") closeEnd += 1;
    if (closeEnd - next === run) return closeEnd;
    i = closeEnd;
  }
  return runEnd;
}

function findUnescaped(text: string, needle: string, from: number): number {
  let i = text.indexOf(needle, from);
  while (i !== -1) {
    let backslashes = 0;
    for (let j = i - 1; j >= from && text[j] === "\\"; j--) backslashes += 1;
    if (backslashes % 2 === 0) return i;
    i = text.indexOf(needle, i + 1);
  }
  return -1;
}
