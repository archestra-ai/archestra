import { z } from "zod";

export const CommonToolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .describe("Represents a tool call in a provider-agnostic way");

export type CommonMcpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

/**
 * Provider-agnostic representation of a tool call from an LLM
 */
export type CommonToolCall = z.infer<typeof CommonToolCallSchema>;

/**
 * Provider-agnostic representation of a tool execution result
 */
export type CommonToolResult = {
  id: string;
  name: string;
  content: unknown;
  isError: boolean;
  error?: string;
};
