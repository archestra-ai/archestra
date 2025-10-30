import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Schema for CommonToolCall
 */
const CommonToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

/**
 * Schema for CommonToolResult
 */
const CommonToolResultSchema = z.object({
  id: z.string(),
  content: z.unknown(),
  isError: z.boolean(),
  error: z.string().optional(),
});

/**
 * Select schema for MCP tool calls
 */
export const SelectMcpToolCallSchema = createSelectSchema(
  schema.mcpToolCallsTable,
  {
    toolCall: CommonToolCallSchema,
    toolResult: CommonToolResultSchema,
  },
);

/**
 * Insert schema for MCP tool calls
 */
export const InsertMcpToolCallSchema = createInsertSchema(
  schema.mcpToolCallsTable,
  {
    toolCall: CommonToolCallSchema,
    toolResult: CommonToolResultSchema,
  },
);

export type McpToolCall = z.infer<typeof SelectMcpToolCallSchema>;
export type InsertMcpToolCall = z.infer<typeof InsertMcpToolCallSchema>;
