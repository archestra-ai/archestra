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

// The regex only finds a credential name; the value is scanned by hand and
// the search resumes past it, keeping the work linear.
function redactText(text: string): string {
  let shown = "";
  let from = 0;
  const heads = new RegExp(CREDENTIAL_HEAD);
  for (let head = heads.exec(text); head; head = heads.exec(text)) {
    const { start, end } = credentialValue(text, head);
    if (end <= start) continue;
    shown += `${text.slice(from, start)}${redactSecret(text.slice(start, end))}`;
    from = end;
    heads.lastIndex = end;
  }
  return `${shown}${text.slice(from)}`;
}

type Span = { start: number; end: number };
type QuoteToken = { quote: string; slashes: number; end: number };

// After a gap that may be shell-escaped, a value quoted from its first
// character, or a bare one: after `=` up to a space, quote or `&`; after `:`
// up to the first unescaped space when shell-escaped (`\ `), else to the end
// of the line. A quote just before an unquoted name opens the argument
// holding the pair, as in `-H 'Cookie: ...'`, and its match ends the value.
function credentialValue(text: string, head: RegExpExecArray): Span {
  const [match, nameClose, separator] = head;
  const enclosing =
    nameClose === undefined ? quoteBefore(text, head.index) : undefined;
  const gap = /(?:\\?\s)*/y;
  gap.lastIndex = head.index + match.length;
  gap.exec(text);
  const at = gap.lastIndex;
  let shell = at > head.index + match.length && text[at - 2] === "\\";
  const open = quoteAt(text, at);
  if (open && !closesEnclosing(open, enclosing)) {
    return { start: open.end, end: closingQuote(text, open, enclosing).start };
  }
  let end = at;
  if (separator === "=") {
    while (end < text.length && !/[\s'"\\&]/.test(text[end] ?? "")) end++;
    return { start: at, end };
  }
  let line = false;
  while (end < text.length) {
    const char = text[end] ?? "";
    if (char === "\n" || char === "\r") break;
    if (isSpace(char)) {
      if (shell) break;
      line = true;
      end++;
      continue;
    }
    const token = quoteAt(text, end);
    if (token) {
      // A quote after `=` or a space opens a quoted part, as in
      // `Digest response="..."`; any other may close an enclosing argument.
      const before = text[end - 1] ?? "";
      if (closesEnclosing(token, enclosing)) break;
      if (end > at && before !== "=" && !isSpace(before)) break;
      end = closingQuote(text, token, enclosing).end;
      continue;
    }
    if (char !== "\\") {
      end++;
      continue;
    }
    const run = slashesEnd(text, end);
    const escapes = (run - end) % 2 === 1 && !/[\r\n]/.test(text[run] ?? "");
    if (escapes && !line && isSpace(text[run])) shell = true;
    end = escapes && shell ? run + 1 : run;
  }
  return { start: at, end };
}

// Quotes may be escaped as many times as the text is nested in JSON: a quote
// with no more backslashes than the opening one closes it. The enclosing
// argument's quote, or the end of the text, ends it unclosed.
function closingQuote(
  text: string,
  open: QuoteToken,
  enclosing: QuoteToken | undefined,
): Span {
  let index = open.end;
  while (index < text.length) {
    const token = quoteAt(text, index);
    if (!token)
      index = text[index] === "\\" ? slashesEnd(text, index) : index + 1;
    else if (closesEnclosing(token, enclosing)) break;
    else if (token.quote === open.quote && token.slashes <= open.slashes)
      return { start: index, end: token.end };
    else index = token.end;
  }
  return { start: index, end: index };
}

function closesEnclosing(
  token: QuoteToken,
  enclosing: QuoteToken | undefined,
): boolean {
  return (
    enclosing !== undefined &&
    token.quote === enclosing.quote &&
    token.slashes <= enclosing.slashes
  );
}

function quoteAt(text: string, at: number): QuoteToken | undefined {
  const run = slashesEnd(text, at);
  const quote = text[run] ?? "";
  return quote === '"' || quote === "'"
    ? { quote, slashes: run - at, end: run + 1 }
    : undefined;
}

function quoteBefore(text: string, at: number): QuoteToken | undefined {
  const quote = text[at - 1] ?? "";
  if (quote !== '"' && quote !== "'") return undefined;
  let start = at - 1;
  while (text[start - 1] === "\\") start--;
  return { quote, slashes: at - 1 - start, end: at };
}

function slashesEnd(text: string, at: number): number {
  let index = at;
  while (text[index] === "\\") index++;
  return index;
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
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
// one, or second in a `[name, value]` pair. A container past `MAX_JSON_DEPTH`
// is shown as `"[redacted]"`, so deep nesting cannot overflow the stack or
// show what it holds.
function walkJson(json: string, at: number, depth = 0): JsonToken {
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
  if ((opener === "{" || opener === "[") && depth > MAX_JSON_DEPTH) {
    const end = containerEnd(json, start);
    const text = JSON.stringify(REDACTED_CREDENTIAL);
    return { start, end, edits: [{ start, end, text }] };
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
    const value = walkJson(json, index, depth + 1);
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

const MAX_JSON_DEPTH = 100;

function containerEnd(json: string, start: number): number {
  let depth = 0;
  for (let index = start; ; index++) {
    const char = json[index];
    if (char === '"') index = stringEnd(json, index) - 1;
    else if (char === "{" || char === "[") depth++;
    else if ((char === "}" || char === "]") && --depth === 0) return index + 1;
  }
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

const CREDENTIAL_NAMES = String.raw`(?:proxy-)?authorization|[\w-]*(?:api|auth|private|access|secret|session|security)[-_]?(?:key|token)|[\w-]*(?:refresh|id)[-_]?token|[\w-]*client[-_]?secret|(?:set-)?cookie`;

const CREDENTIAL_NAME = new RegExp(`^(?:${CREDENTIAL_NAMES})$`, "i");

// A name starting a word, so a long word is tried once, possibly quoted, then
// `:` or `=`.
const CREDENTIAL_HEAD = new RegExp(
  String.raw`(?<![\w-])(?:${CREDENTIAL_NAMES})(\\*["'])?\s*([:=])`,
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
