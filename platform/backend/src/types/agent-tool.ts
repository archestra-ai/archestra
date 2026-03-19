import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { UuidIdSchema } from "./api";
import { ToolParametersContentSchema } from "./tool";

export interface AgentToolAssignmentIntent {
  /** Exact tool ID to assign. */
  toolId: string;
  /**
   * Preferred late-bound mode for builder flows.
   * When true, resolve both credentials and the execution target at tool call time.
   */
  resolveAtCallTime?: boolean;
  /**
   * Compatibility alias for `resolveAtCallTime`.
   * Keep using `resolveAtCallTime` in new code and MCP tool calls; this field only
   * exists so older callers do not break.
   */
  useDynamicTeamCredential?: boolean;
  /**
   * Explicit remote MCP installation to use as the credential source.
   * This means "use credentials from this specific installed MCP server" instead
   * of resolving credentials dynamically at tool call time.
   */
  credentialSourceMcpServerId?: string | null;
  /**
   * Explicit local MCP installation to use as the execution target.
   * This means "run the tool on this specific installed MCP server" instead of
   * resolving the execution target dynamically at tool call time.
   */
  executionSourceMcpServerId?: string | null;
}

export const SelectAgentToolSchema = createSelectSchema(schema.agentToolsTable)
  .omit({
    agentId: true,
    toolId: true,
  })
  .extend({
    agent: z.object({
      id: z.string(),
      name: z.string(),
    }),
    tool: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      parameters: ToolParametersContentSchema,
      createdAt: z.date(),
      updatedAt: z.date(),
      catalogId: z.string().nullable(),
    }),
  });

export const InsertAgentToolSchema = createInsertSchema(schema.agentToolsTable);
export const UpdateAgentToolSchema = createUpdateSchema(schema.agentToolsTable);
export const AgentToolAssignmentInputSchema = z.object({
  toolId: UuidIdSchema,
  resolveAtCallTime: z.boolean().optional(),
  useDynamicTeamCredential: z.boolean().optional(),
  credentialSourceMcpServerId: UuidIdSchema.nullable().optional(),
  executionSourceMcpServerId: UuidIdSchema.nullable().optional(),
});

export const AgentToolAssignmentBodySchema =
  AgentToolAssignmentInputSchema.omit({
    toolId: true,
  }).nullish();

export const BulkAgentToolAssignmentSchema =
  AgentToolAssignmentInputSchema.extend({
    agentId: UuidIdSchema,
  });

export const AgentToolFilterSchema = z.object({
  search: z.string().optional(),
  agentId: UuidIdSchema.optional(),
  origin: z.string().optional().describe("A catalogId to filter by"),
  mcpServerOwnerId: z
    .string()
    .optional()
    .describe("Filter by MCP server owner user ID"),
  excludeArchestraTools: z.coerce
    .boolean()
    .optional()
    .describe("For test isolation"),
});

export const AgentToolSortBy = [
  "name",
  "agent",
  "origin",
  "createdAt",
] as const;
export type AgentToolSortBy = (typeof AgentToolSortBy)[number];

export type AgentTool = z.infer<typeof SelectAgentToolSchema>;
export type InsertAgentTool = z.infer<typeof InsertAgentToolSchema>;
export type UpdateAgentTool = z.infer<typeof UpdateAgentToolSchema>;

export type AgentToolFilters = z.infer<typeof AgentToolFilterSchema>;

export type McpToolAssignment = {
  toolName: string;
  credentialSourceMcpServerId: string | null;
  executionSourceMcpServerId: string | null;
  useDynamicTeamCredential: boolean;
  catalogId: string | null;
  catalogName: string | null;
};
