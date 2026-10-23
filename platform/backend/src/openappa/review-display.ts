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
  const { review } = params;
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
