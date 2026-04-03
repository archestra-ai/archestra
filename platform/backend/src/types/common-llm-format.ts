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
