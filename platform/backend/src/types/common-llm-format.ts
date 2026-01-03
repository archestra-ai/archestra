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
};

/**
 * Result of evaluating trusted data policies
 * Maps tool call IDs to their updated content (if modified)
 */
export type ToolResultUpdates = Record<string, string>;

export interface CommonMessage {
  /** Message role */
  role: "user" | "assistant" | "tool" | "system" | "model" | "function";
  /** Tool calls if this message contains them */
  toolCalls?: CommonToolResult[];
}
