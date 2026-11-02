/**
 * The reviewed call as an approval prompt shows it: the tool by the name the
 * user knows it under, and its arguments as named values.
 */

/**
 * The call an approval prompt shows. An OpenAPPA review names the call it
 * rules on, while the paused remedy call's own name and arguments only name
 * the plan; a review without a structured tool falls back to its text.
 */
export function approvalPromptCall(params: {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  review?: { text: string; tool?: string; arguments?: string };
}): {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  reviewText?: string;
} {
  const review = params.review && displayedReview(params.review);
  if (review?.tool) {
    const toolArgs = parseReviewedArguments(review.arguments);
    return {
      toolName: reviewedToolLabel(review.tool),
      ...(toolArgs ? { toolArgs } : {}),
    };
  }
  return {
    toolName: params.toolName,
    ...(params.toolArgs ? { toolArgs: params.toolArgs } : {}),
    ...(review ? { reviewText: review.text } : {}),
  };
}

/**
 * OpenAPPA names a gateway tool `mcp/<server>/<tool>`. Prompts show it the
 * way the agent called it, `<server>__<tool>`; any other name is kept as is.
 */
export function reviewedToolLabel(tool: string): string {
  const parts = tool.split("/");
  if (parts.length === 3 && parts[0] === "mcp" && parts[1] && parts[2])
    return `${parts[1]}__${parts[2]}`;
  return tool;
}

/** The reviewed arguments as an object, or undefined when they are not one. */
export function parseReviewedArguments(
  json: string | undefined,
): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The review as a person sees it, with credential header values replaced.
 * Display only: the staged payload, its digest and the ruling stay bound to
 * the exact call.
 */
export function displayedReview<
  T extends { text: string; arguments?: string; summary?: string },
>(review: T): T {
  return {
    ...review,
    text: redactCredentials(review.text),
    ...(review.arguments === undefined
      ? {}
      : { arguments: redactCredentials(review.arguments) }),
    ...(review.summary === undefined
      ? {}
      : { summary: redactCredentials(review.summary) }),
  };
}

/**
 * The text with credential header values replaced, for display only. JSON,
 * whether it is the whole text, embedded in it or encoded in its strings, is
 * redacted by structure and stays parseable; any other text by its
 * `Name: value` and `Name=value` pairs.
 */
export function redactCredentials(text: string): string {
  let shown = "";
  let from = 0;
  let start = 0;
  let depth = 0;
  let inString = false;
  // One pass: each top-level bracketed span is parsed once when it closes,
  // and skipped whole when it is not JSON.
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === "{" || char === "[") {
      if (depth++ === 0) start = index;
    } else if (depth > 0 && char === '"') inString = true;
    else if (depth > 0 && (char === "}" || char === "]") && --depth === 0) {
      const span = text.slice(start, index + 1);
      if (!isJson(span)) continue;
      shown += `${redactText(text.slice(from, start))}${redactSpan(span)}`;
      from = index + 1;
    }
  }
  return `${shown}${redactText(text.slice(from))}`;
}

// Only masked string tokens are rewritten, so every other byte of the span,
// numbers past double precision and indentation included, stays as written.
function redactSpan(span: string): string {
  let shown = "";
  let from = 0;
  for (const edit of walkJson(span, 0).edits) {
    shown += `${span.slice(from, edit.start)}${edit.text}`;
    from = edit.end;
  }
  return `${shown}${span.slice(from)}`;
}

function redactText(text: string): string {
  return text.replace(CREDENTIAL_TEXT, redactTextPair);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

type Edit = { start: number; end: number; text: string };
type JsonToken = { start: number; end: number; text?: string; edits: Edit[] };

// Walks a span already known to be valid JSON. A credential sits under a
// header-named key, in the `value` beside a `name`, `key` or `header` naming
// one, or second in a `[name, value]` pair.
function walkJson(json: string, at: number): JsonToken {
  const start = skipSpace(json, at);
  const opener = json[start];
  if (opener === '"') {
    const end = stringEnd(json, start);
    const text: string = JSON.parse(json.slice(start, end));
    const shown = redactCredentials(text);
    const edits =
      shown === text ? [] : [{ start, end, text: JSON.stringify(shown) }];
    return { start, end, text, edits };
  }
  if (opener !== "{" && opener !== "[") {
    let end = start;
    while (end < json.length && /[\w.+-]/.test(json[end] ?? "")) end++;
    return { start, end, edits: [] };
  }
  const members: { key?: string; value: JsonToken }[] = [];
  let index = skipSpace(json, start + 1);
  while (json[index] !== "}" && json[index] !== "]") {
    let key: string | undefined;
    if (opener === "{") {
      const keyEnd = stringEnd(json, index);
      key = JSON.parse(json.slice(index, keyEnd));
      index = skipSpace(json, keyEnd) + 1;
    }
    const value = walkJson(json, index);
    members.push({ key, value });
    index = skipSpace(json, value.end);
    if (json[index] === ",") index = skipSpace(json, index + 1);
  }
  const pairNamed = members.some(
    ({ key, value }) => PAIR_NAME_KEYS.has(key ?? "") && namesCredential(value),
  );
  const masked = (key: string | undefined, member: number) =>
    key === undefined
      ? member === 1 &&
        members.length === 2 &&
        namesCredential(members[0]?.value)
      : CREDENTIAL_NAME.test(key) || (pairNamed && key === "value");
  const edits = members.flatMap(({ key, value }, member) =>
    masked(key, member)
      ? [
          {
            start: value.start,
            end: value.end,
            text: JSON.stringify(
              value.text === undefined
                ? REDACTED_CREDENTIAL
                : redactSecret(value.text),
            ),
          },
        ]
      : value.edits,
  );
  return { start, end: index + 1, edits };
}

function namesCredential(token: JsonToken | undefined): boolean {
  return token?.text !== undefined && CREDENTIAL_NAME.test(token.text);
}

function skipSpace(json: string, at: number): number {
  let index = at;
  while (/\s/.test(json[index] ?? "")) index++;
  return index;
}

function stringEnd(json: string, start: number): number {
  let index = start + 1;
  while (json[index] !== '"') index += json[index] === "\\" ? 2 : 1;
  return index + 1;
}

function redactTextPair(
  _pair: string,
  prefix: string,
  open: string | undefined,
  quoted: string | undefined,
  close: string | undefined,
  bare: string | undefined,
): string {
  return open === undefined
    ? `${prefix}${redactSecret(bare ?? "")}`
    : `${prefix}${open}${redactSecret(quoted ?? "")}${close ?? ""}`;
}

// Only a known scheme stays visible: any other word before a gap may be the
// credential itself.
function redactSecret(value: string): string {
  const [, scheme, gap] =
    /^([A-Za-z][\w-]*)((?:\\*\s)+)(?=\S)/.exec(value) ?? [];
  return scheme && gap && AUTH_SCHEMES.has(scheme.toLowerCase())
    ? `${scheme}${gap}${REDACTED_CREDENTIAL}`
    : REDACTED_CREDENTIAL;
}

const REDACTED_CREDENTIAL = "[redacted]";

const AUTH_SCHEMES = new Set([
  "basic",
  "bearer",
  "bot",
  "digest",
  "negotiate",
  "ntlm",
  "token",
]);

const PAIR_NAME_KEYS = new Set(["name", "key", "header"]);

const CREDENTIAL_NAMES = String.raw`(?:proxy-)?authorization|[\w-]*(?:api|auth|private)[-_]?(?:key|token)|(?:set-)?cookie`;

const CREDENTIAL_NAME = new RegExp(`^(?:${CREDENTIAL_NAMES})$`, "i");

// The name, starting a word so a long word is tried once, possibly quoted,
// `:` or `=`, a gap that may be shell-escaped, then either a value quoted
// from its first character through the matching quote, or a bare value: after
// `:` up to the end of the line or a quote, which may close an enclosing
// argument; after `=` up to a space, quote or `&`, as in a query string.
// Quotes may be escaped as many times as the text is nested in JSON.
const CREDENTIAL_TEXT = new RegExp(
  String.raw`((?<![\w-])(?:${CREDENTIAL_NAMES})(?:\\*["'])?\s*[:=](?:\\?\s)*)(?:(\\*["'])([\s\S]*?)(\2|$)|((?<=:(?:\\?\s)*)(?:\\(?![\\"'])|[^\r\n'"\\])+|[^\s'"\\&]+))`,
  "gi",
);

/**
 * Argument values as one line each, names padded to one column, longer
 * values wrapped at `width` and indented under the value column.
 */
export function formatArgumentLines(
  args: Record<string, unknown>,
  width = 72,
): string {
  const names = Object.keys(args);
  if (names.length === 0) return "";
  const column = Math.max(...names.map((name) => name.length)) + 2;
  const valueWidth = Math.max(20, width - column);
  return names
    .flatMap((name) => {
      const raw = args[name];
      const value = typeof raw === "string" ? raw : JSON.stringify(raw);
      return wrap(value ?? "", valueWidth).map((line, index) =>
        index === 0
          ? `${name.padEnd(column)}${line}`
          : `${" ".repeat(column)}${line}`,
      );
    })
    .join("\n");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = "";
      }
      line = line ? `${line} ${word}` : word;
      while (line.length > width) {
        lines.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    lines.push(line);
  }
  return lines;
}
