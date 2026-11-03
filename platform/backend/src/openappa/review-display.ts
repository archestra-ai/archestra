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

// The regex only finds a credential name and its separator; the value is
// scanned by hand and the search resumes past it, so every character is read
// a bounded number of times.
function redactText(text: string): string {
  let shown = "";
  let from = 0;
  const heads = new RegExp(CREDENTIAL_HEAD);
  for (let head = heads.exec(text); head; head = heads.exec(text)) {
    const value = credentialValue(text, head);
    if (!value) continue;
    shown += `${text.slice(from, value.start)}${redactSecret(text.slice(value.start, value.end))}`;
    from = value.end;
    heads.lastIndex = Math.max(heads.lastIndex, value.end);
  }
  return `${shown}${text.slice(from)}`;
}

type Span = { start: number; end: number };
type QuoteToken = {
  quote: string;
  slashes: number;
  start: number;
  end: number;
};

// After `:` or `=` a gap that may be shell-escaped, then a value quoted from
// its first character, or a bare one: after `=` see `equalsValueEnd`, after
// `:` see `colonValueEnd`. Second in a quoted `"name", "value"` tuple, the
// quoted value. A quote just before the name opens the argument holding the
// pair, as in `-H 'Cookie: ...'`, and its match ends the value.
function credentialValue(
  text: string,
  head: RegExpExecArray,
): Span | undefined {
  const [match, nameClose, separator] = head;
  let at = head.index + match.length;
  if (separator === ",") {
    const quoted =
      nameClose !== undefined &&
      text.startsWith(nameClose, head.index - nameClose.length);
    return quoted ? tupleValue(text, skipSpace(text, at)) : undefined;
  }
  const enclosing =
    nameClose === undefined ? quoteTokenBefore(text, head.index) : undefined;
  let escapedGap = false;
  for (;;) {
    if (text[at] === "\\" && isSpace(text[at + 1])) {
      at += 2;
      escapedGap = true;
    } else if (isSpace(text[at])) {
      at++;
      escapedGap = false;
    } else break;
  }
  const open = quoteToken(text, at);
  if (open && !closesEnclosing(open, enclosing)) {
    const close = closingQuote(text, open, false, enclosing);
    if (close.start > open.end && !continuesWord(text, close.end, enclosing))
      return { start: open.end, end: close.start };
  }
  const end =
    separator === "="
      ? equalsValueEnd(text, at, enclosing)
      : colonValueEnd(text, at, escapedGap, enclosing);
  return end > at ? { start: at, end } : undefined;
}

// Quoted literals, possibly prefixed as in Python's `r'...'` and adjacent as
// in `'Bearer ' 'tok'`, read as one value.
function tupleValue(text: string, at: number): Span | undefined {
  let value: Span | undefined;
  let index = at;
  for (;;) {
    let literal = index;
    while (literal < index + 2 && /[bfru]/i.test(text[literal] ?? ""))
      literal++;
    const open = quoteToken(text, literal) ?? quoteToken(text, index);
    if (!open) return value;
    const close = closingQuote(text, open, false, undefined);
    value = { start: value?.start ?? open.end, end: close.start };
    if (close.end === close.start) return value;
    index = skipSpace(text, close.end);
  }
}

// A bare value after `=`, as in a query string or a shell assignment: up to
// a space or `&`, reading escaped characters and quoted parts that open it
// or follow one another.
function equalsValueEnd(
  text: string,
  at: number,
  enclosing: QuoteToken | undefined,
): number {
  let index = at;
  let afterQuoted = false;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (isSpace(char) || char === "&") break;
    if (!QUOTES.has(char) && char !== "\\") {
      index++;
      afterQuoted = false;
      continue;
    }
    const token = quoteToken(text, index);
    if (token) {
      if (closesEnclosing(token, enclosing) || (index > at && !afterQuoted))
        break;
      index = closingQuote(text, token, true, enclosing).end;
      afterQuoted = true;
      continue;
    }
    index = escapeEnd(text, index, true);
    afterQuoted = false;
  }
  return index;
}

// A bare value after `:`. Shell-escaped (`\ ` in the gap or before any
// space) it runs to the first unescaped space, else to the end of the line.
// A quote opening the value, following a quoted part, or after `=` or a
// space opens a quoted part that is read through its match, as in
// `Digest response="..."` or `sid="..."`; any other quote ends the value,
// since it may close an enclosing argument.
function colonValueEnd(
  text: string,
  at: number,
  escapedGap: boolean,
  enclosing: QuoteToken | undefined,
): number {
  let mode: "unknown" | "line" | "shell" = escapedGap ? "shell" : "unknown";
  let index = at;
  let afterQuoted = false;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\n" || char === "\r") break;
    if (isSpace(char)) {
      if (mode === "shell") break;
      mode = "line";
      index++;
      afterQuoted = false;
      continue;
    }
    if (!QUOTES.has(char) && char !== "\\") {
      index++;
      afterQuoted = false;
      continue;
    }
    const token = quoteToken(text, index);
    if (token) {
      if (closesEnclosing(token, enclosing)) break;
      const before = text[index - 1] ?? "";
      if (index > at && !afterQuoted && before !== "=" && !isSpace(before))
        break;
      index = closingQuote(text, token, true, enclosing).end;
      afterQuoted = true;
      if (mode === "unknown") mode = "line";
      continue;
    }
    const run = backslashRunEnd(text, index);
    if ((run - index) % 2 === 1 && isSpace(text[run]) && mode !== "line")
      mode = "shell";
    index = escapeEnd(text, index, mode !== "line");
    afterQuoted = false;
  }
  return index;
}

// Past a backslash run, and past the character it escapes when `escapes`.
function escapeEnd(text: string, at: number, escapes: boolean): number {
  const run = backslashRunEnd(text, at);
  const next = text[run];
  return escapes &&
    (run - at) % 2 === 1 &&
    next !== undefined &&
    next !== "\n" &&
    next !== "\r"
    ? run + 1
    : run;
}

// Quotes may be escaped as many times as the text is nested in JSON: a quote
// with no more backslashes than the opening one closes it, as does one after
// an even run when the opening one has none. The enclosing argument's quote
// ends the value unclosed.
function closingQuote(
  text: string,
  open: QuoteToken,
  withinLine: boolean,
  enclosing: QuoteToken | undefined,
): Span {
  let index = open.end;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (withinLine && (char === "\n" || char === "\r")) break;
    if (!QUOTES.has(char) && char !== "\\") {
      index++;
      continue;
    }
    const token = quoteToken(text, index);
    if (!token) index = backslashRunEnd(text, index);
    else if (closesEnclosing(token, enclosing)) break;
    else if (
      token.quote === open.quote &&
      (token.slashes <= open.slashes ||
        (open.slashes === 0 && token.slashes % 2 === 0))
    )
      return {
        start: token.end - 1 - Math.min(token.slashes, open.slashes),
        end: token.end,
      };
    else index = token.end;
  }
  return { start: index, end: index };
}

// Whether the shell word goes on past a closing quote, as in `'sek'ret`.
function continuesWord(
  text: string,
  at: number,
  enclosing: QuoteToken | undefined,
): boolean {
  const token = quoteToken(text, at);
  return token
    ? !closesEnclosing(token, enclosing)
    : /[\w.~+/=-]/.test(text[at] ?? "");
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

const QUOTES = new Set(['"', "'", "`"]);

function quoteToken(text: string, at: number): QuoteToken | undefined {
  const run = backslashRunEnd(text, at);
  const quote = text[run] ?? "";
  return QUOTES.has(quote)
    ? { quote, slashes: run - at, start: at, end: run + 1 }
    : undefined;
}

function quoteTokenBefore(text: string, at: number): QuoteToken | undefined {
  const quote = text[at - 1] ?? "";
  if (!QUOTES.has(quote)) return undefined;
  let start = at - 1;
  while (text[start - 1] === "\\") start--;
  return { quote, slashes: at - 1 - start, start, end: at };
}

function backslashRunEnd(text: string, at: number): number {
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
// `:`, `=` or the `,` of a tuple.
const CREDENTIAL_HEAD = new RegExp(
  String.raw`(?<![\w-])(?:${CREDENTIAL_NAMES})(\\*["'\`])?\s*([:=,])`,
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
