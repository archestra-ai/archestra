import { LOCKED_CHAT_REDACTED_VALUES } from "@archestra/shared";
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
/**
 * The two shapes a locked-chat row's content takes when it is not available to
 * the reader: encrypted under the browser key, or never stored.
 */
const LockedChatUnavailableContentSchema = z.union([
  z.object({ __lockedChatSealed: z.string() }),
  z.object({ __redacted: z.enum(LOCKED_CHAT_REDACTED_VALUES) }),
]);

export const SelectMcpToolCallSchema = createSelectSchema(
  schema.mcpToolCallsTable,
  {
    toolCall: CommonToolCallSchema.nullable(),
    // toolResult can have different structures depending on the method type
    toolResult: z.unknown().nullable(),
    authMethod: MCPGatewayAuthMethodSchema.nullable(),
  },
)
  // Server-side plumbing telling the read path which key the row is under.
  // Clients never need it: a locked row announces itself through the sentinel,
  // which carries the conversation id.
  .omit({ lockedChatConversationId: true })
  .extend({
    userName: z.string().nullable(),
    // Name of the owning app for app-owned calls; null for agent-owned calls
    // or when the app was deleted.
    appName: z.string().nullable(),
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

/**
 * What routes serialize. A locked-chat row carries a sentinel where the
 * recorded call would be — unavailable, not malformed — so the response schema
 * has to admit it or one such row fails serialization for the whole list.
 * Deliberately separate from the select schema above: widening that would push
 * the union onto every consumer of `McpToolCall`, which only ever handles real
 * calls. `toolResult` needs no equivalent; it is already unknown.
 */
export const McpToolCallResponseSchema = SelectMcpToolCallSchema.extend({
  toolCall: z
    .union([CommonToolCallSchema, LockedChatUnavailableContentSchema])
    .nullable(),
});

export type McpToolCall = z.infer<typeof SelectMcpToolCallSchema>;
export type InsertMcpToolCall = z.infer<typeof InsertMcpToolCallSchema>;
