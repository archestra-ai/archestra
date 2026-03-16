import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { UuidIdSchema } from "./api";
import { ToolParametersContentSchema } from "./tool";

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
