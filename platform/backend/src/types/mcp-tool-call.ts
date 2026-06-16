import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { CommonToolCallSchema } from "./common-llm-format";
import { ToolOwnerTypeSchema } from "./tool-owner";

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
  "session",
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
 * Insert schema for MCP tool calls. `ownerType` is optional and the DB column
 * defaults to "agent", so existing agent call sites are unchanged; the refine
 * then requires the matching owner id (agentId for agent calls, appId for app
 * calls). Both id columns stay nullable in the DB so audit rows survive owner
 * deletion.
 */
export const InsertMcpToolCallSchema = createInsertSchema(
  schema.mcpToolCallsTable,
  {
    toolCall: CommonToolCallSchema.nullable(),
    // toolResult can have different structures depending on the method type
    toolResult: z.unknown().nullable(),
    authMethod: MCPGatewayAuthMethodSchema.nullable().optional(),
  },
)
  .extend({
    ownerType: ToolOwnerTypeSchema.optional(),
    agentId: z.string().uuid().nullable().optional(),
    appId: z.string().uuid().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    // Exactly the matching owner id must be set and the other must be absent, so
    // a row can never be authorized through the wrong owner path.
    if ((value.ownerType ?? "agent") === "agent") {
      if (!value.agentId) {
        ctx.addIssue({
          code: "custom",
          message: "agent-owned tool calls require agentId",
        });
      }
      if (value.appId) {
        ctx.addIssue({
          code: "custom",
          message: "agent-owned tool calls must not set appId",
        });
      }
    } else {
      if (!value.appId) {
        ctx.addIssue({
          code: "custom",
          message: "app-owned tool calls require appId",
        });
      }
      if (value.agentId) {
        ctx.addIssue({
          code: "custom",
          message: "app-owned tool calls must not set agentId",
        });
      }
    }
  });

export type McpToolCall = z.infer<typeof SelectMcpToolCallSchema>;
export type InsertMcpToolCall = z.infer<typeof InsertMcpToolCallSchema>;
