import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { CommonToolCallSchema } from "./common-llm-format";

/**
 * Auth method types for MCP tool call logging.
 * Tracks how the caller authenticated to the MCP Gateway.
 */
export const MCPGatewayAuthMethodSchema = z.enum([
  "oauth",
  "user_token",
  "org_token",
  "team_token",
  "external_idp",
]);
export type MCPGatewayAuthMethod = z.infer<typeof MCPGatewayAuthMethodSchema>;

/**
 * Select schema for MCP tool calls (includes joined userName from users table)
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
    authMethod: MCPGatewayAuthMethodSchema.nullable(),
  },
).extend({
  userName: z.string().nullable(),
});

/**
 * Insert schema for MCP tool calls
 */
export const InsertMcpToolCallSchema = createInsertSchema(
  schema.mcpToolCallsTable,
  {
    toolCall: CommonToolCallSchema.nullable(),
    // toolResult can have different structures depending on the method type
    toolResult: z.unknown().nullable(),
    authMethod: MCPGatewayAuthMethodSchema.nullable().optional(),
  },
);

export type McpToolCall = z.infer<typeof SelectMcpToolCallSchema>;
export type InsertMcpToolCall = z.infer<typeof InsertMcpToolCallSchema>;
