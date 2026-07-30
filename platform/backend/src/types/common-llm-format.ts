import { z } from "zod";

/**
 * Common LLM Format Types
 *
 * Note: for now we do not aim to convert whole provider messages to this format, but
 * rather convert subset of the data we actually need for the business logic.
 */

export type CommonMcpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export const CommonToolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .describe("Represents a tool call in a provider-agnostic way");

export type CommonToolCall = z.infer<typeof CommonToolCallSchema>;

export type CommonToolResult = {
  id: string;
  name: string;
  /**
   * The arguments of the paired tool call, when the source format carries
   * them. Required to resolve a `run_tool` dispatch to its target tool so
   * trusted-data policies evaluate the tool that actually produced the
   * result instead of the built-in wrapper.
   */
  arguments?: Record<string, unknown>;
  content: unknown;
  isError: boolean;
  error?: string;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
};

/**
 * Result of evaluating trusted data policies
 * Maps tool call IDs to their updated content (if modified)
 */
export type ToolResultUpdates = Record<string, string>;

export interface CommonMessage {
  /** Message role */
  role: "user" | "assistant" | "tool" | "system" | "model" | "function";
  /** Best-effort text content for the message when available */
  content?: string;
  /** Tool calls if this message contains them */
  toolCalls?: CommonToolResult[];
}

/**
 * Normalize a provider-format tool-call arguments value to the record shape
 * `CommonToolResult.arguments` carries. Providers carry arguments either as an
 * object (Anthropic `input`, Gemini `args`) or as a JSON string (OpenAI-family
 * `function.arguments`); anything unparsable yields undefined so a malformed
 * value is indistinguishable from an uncaptured one (both fail closed where it
 * matters — run_tool dispatch resolution).
 */
export function extractCommonToolCallArguments(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return extractCommonToolCallArguments(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function extractCommonMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if ("content" in message) {
    return normalizeExtractedText(extractTextValue(message.content));
  }

  if ("parts" in message) {
    return normalizeExtractedText(extractTextValue(message.parts));
  }

  return undefined;
}

function extractTextValue(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }

    if (!item || typeof item !== "object") {
      return [];
    }

    if ("type" in item) {
      if (
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        return [item.text];
      }

      return [];
    }

    if ("text" in item && typeof item.text === "string") {
      return [item.text];
    }

    if ("content" in item) {
      return extractTextValue(item.content);
    }

    if ("parts" in item) {
      return extractTextValue(item.parts);
    }

    return [];
  });
}

function normalizeExtractedText(textParts: string[]): string | undefined {
  const normalized = textParts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");

  return normalized.length > 0 ? normalized : undefined;
}
