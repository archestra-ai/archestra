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

/** The text with credential header values replaced, for display only. */
export function redactCredentials(text: string): string {
  return text.replace(
    CREDENTIAL_HEADER,
    (
      _credential,
      authorization: string | undefined,
      scheme: string | undefined,
      gap: string | undefined,
      header: string | undefined,
    ) =>
      authorization === undefined
        ? `${header}${REDACTED_CREDENTIAL}`
        : scheme && AUTH_SCHEMES.has(scheme.toLowerCase())
          ? `${authorization}${scheme}${gap}${REDACTED_CREDENTIAL}`
          : `${authorization}${REDACTED_CREDENTIAL}`,
  );
}

const REDACTED_CREDENTIAL = "[redacted]";

// Only a known scheme stays visible: any other word before a gap may be the
// credential itself.
const AUTH_SCHEMES = new Set([
  "basic",
  "bearer",
  "bot",
  "digest",
  "negotiate",
  "ntlm",
  "token",
]);

// A credential header as a command or JSON string carries it: the name, an
// optional auth scheme, then the credential up to a quote, backslash or
// space, so a JSON payload stays parseable. A gap is whitespace, possibly
// shell-escaped (`\ `, or `\\ ` inside a JSON string).
const CREDENTIAL_HEADER =
  /((?:proxy-)?authorization\s*:(?:\\*\s)*)(?:([A-Za-z][\w-]*)((?:\\*\s)+))?[^\s'"\\]+|((?:api-key|auth-token|private-token)\s*:(?:\\*\s)*)[^\s'"\\]+/gi;

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
