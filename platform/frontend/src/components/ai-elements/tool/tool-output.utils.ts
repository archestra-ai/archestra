import type { ToolUIPart } from "ai";

export function normalizeToolOutput(output: ToolUIPart["output"]): unknown {
  if (!isMcpToolOutput(output)) {
    return output;
  }

  if (output.content) {
    return output.content;
  }

  if (output.structuredContent !== undefined) {
    return output.structuredContent;
  }

  return output;
}

function isMcpToolOutput(value: unknown): value is {
  content?: string;
  structuredContent?: unknown;
  rawContent?: unknown;
  _meta?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    (("content" in value && typeof value.content === "string") ||
      "structuredContent" in value)
  );
}
