import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { CommonToolCallSchema } from "./tool-execution";

/**
 * Select schema for MCP tool calls
 * Note: toolResult structure varies by method type:
 * - tools/call: { id, content, isError, error? }
 * - tools/list: { tools: [...] }
 * - initialize: { capabilities, serverInfo }
 */
export const SelectMcpToolCallSchema = createSelectSchema(
  schema.mcpToolCallsTable,
  {
    toolCall: CommonToolCallSchema.nullable(),
    // toolResult can have different structures depending on the method type
    toolResult: z.unknown().nullable(),
  },
);

/**
 * Insert schema for MCP tool calls
 */
export const InsertMcpToolCallSchema = createInsertSchema(
  schema.mcpToolCallsTable,
  {
    toolCall: CommonToolCallSchema.nullable(),
    // toolResult can have different structures depending on the method type
    toolResult: z.unknown().nullable(),
  },
);

export type McpToolCall = z.infer<typeof SelectMcpToolCallSchema>;
export type InsertMcpToolCall = z.infer<typeof InsertMcpToolCallSchema>;
