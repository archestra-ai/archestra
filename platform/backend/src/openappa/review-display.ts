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
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const end = jsonSpanEnd(text, start);
    const span = text.slice(start, end);
    const json = end === undefined ? undefined : parseJsonContainer(span);
    if (end === undefined || json === undefined) continue;
    const indent = /\n([ \t]+)/.exec(span)?.[1];
    const redacted = JSON.stringify(redactJson(json), null, indent);
    shown += `${redactText(text.slice(from, start))}${
      redacted === JSON.stringify(json, null, indent) ? span : redacted
    }`;
    from = end;
    start = end - 1;
  }
  return `${shown}${redactText(text.slice(from))}`;
}

function redactText(text: string): string {
  return text.replace(CREDENTIAL_TEXT, redactTextPair);
}

// The end of the bracketed span opening at `start`, skipping JSON strings.
function jsonSpanEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if ((char === "}" || char === "]") && --depth === 0) return index + 1;
  }
  return undefined;
}

function parseJsonContainer(text: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// A credential sits under a header-named key, in the `value` beside a
// `name`, `key` or `header` naming one, or second in a `[name, value]` pair.
function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactCredentials(value);
  if (Array.isArray(value)) {
    const [name, secret] = value;
    return value.length === 2 &&
      typeof name === "string" &&
      CREDENTIAL_NAME.test(name)
      ? [name, redactField(secret)]
      : value.map(redactJson);
  }
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  const namesCredential = entries.some(
    ([key, field]) =>
      PAIR_NAME_KEYS.has(key) &&
      typeof field === "string" &&
      CREDENTIAL_NAME.test(field),
  );
  return Object.fromEntries(
    entries.map(([key, field]) => [
      key,
      CREDENTIAL_NAME.test(key) || (namesCredential && key === "value")
        ? redactField(field)
        : redactJson(field),
    ]),
  );
}

function redactField(field: unknown): string {
  return typeof field === "string" ? redactSecret(field) : REDACTED_CREDENTIAL;
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

// The name, possibly quoted, `:` or `=`, a gap that may be shell-escaped,
// then either a value quoted from its first character through the matching
// quote, or a bare value up to a quote, backslash or space, which after an
// authorization header may follow a scheme. Quotes may be escaped as many times as the text is nested in JSON.
const CREDENTIAL_TEXT = new RegExp(
  String.raw`((?:${CREDENTIAL_NAMES})(?:\\*["'])?\s*[:=](?:\\?\s)*)(?:(\\*["'])([\s\S]*?)(\2|$)|((?:(?<=authorization(?:\\*["'])?\s*[:=](?:\\?\s)*)[A-Za-z][\w-]*(?:\\*\s)+)?[^\s'"\\]+))`,
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
