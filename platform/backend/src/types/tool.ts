import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

import { OpenAi } from "./llm-providers";

/**
 * As we support more llm provider types, this type will expand and should be updated
 */
export const ToolParametersContentSchema = z.union([
  OpenAi.Tools.FunctionDefinitionParametersSchema,
]);

export const SelectToolSchema = createSelectSchema(schema.toolsTable, {
  parameters: ToolParametersContentSchema,
});

export const ExtendedSelectToolSchema = SelectToolSchema.omit({
  agentId: true,
  mcpServerId: true,
}).extend({
  // Nullable for MCP tools
  agent: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  // Nullable for tools "sniffed" from LLM proxy requests
  mcpServer: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
});

export const InsertToolSchema = createInsertSchema(schema.toolsTable, {
  parameters: ToolParametersContentSchema,
});
export const UpdateToolSchema = createUpdateSchema(schema.toolsTable, {
  parameters: ToolParametersContentSchema.optional(),
});

export type Tool = z.infer<typeof SelectToolSchema>;
export type ExtendedTool = z.infer<typeof ExtendedSelectToolSchema>;
export type InsertTool = z.infer<typeof InsertToolSchema>;
export type UpdateTool = z.infer<typeof UpdateToolSchema>;

export type ToolParametersContent = z.infer<typeof ToolParametersContentSchema>;

// Tool assignment schema (for embedding in ToolWithAssignments)
export const ToolAssignmentSchema = z.object({
  agentToolId: z.string(),
  agent: z.object({
    id: z.string(),
    name: z.string(),
  }),
  credentialSourceMcpServerId: z.string().nullable(),
  credentialOwnerEmail: z.string().nullable(),
  executionSourceMcpServerId: z.string().nullable(),
  executionOwnerEmail: z.string().nullable(),
  useDynamicTeamCredential: z.boolean(),
  responseModifierTemplate: z.string().nullable(),
});

// Tool with embedded assignments schema
export const ToolWithAssignmentsSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parameters: ToolParametersContentSchema,
  catalogId: z.string().nullable(),
  mcpServerId: z.string().nullable(),
  mcpServerName: z.string().nullable(),
  mcpServerCatalogId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  assignmentCount: z.number(),
  assignments: z.array(ToolAssignmentSchema),
});

// Filter schema for tools with assignments
export const ToolFilterSchema = z.object({
  search: z.string().optional(),
  origin: z.string().optional().describe("Can be 'llm-proxy' or a catalogId"),
  excludeArchestraTools: z.coerce
    .boolean()
    .optional()
    .describe("Hide built-in Archestra tools"),
});

// Sort options for tools
export const ToolSortBySchema = z.enum([
  "name",
  "origin",
  "createdAt",
  "assignmentCount",
]);
export const ToolSortDirectionSchema = z.enum(["asc", "desc"]);

export type ToolAssignment = z.infer<typeof ToolAssignmentSchema>;
export type ToolWithAssignments = z.infer<typeof ToolWithAssignmentsSchema>;
export type ToolFilters = z.infer<typeof ToolFilterSchema>;
export type ToolSortBy = z.infer<typeof ToolSortBySchema>;
export type ToolSortDirection = z.infer<typeof ToolSortDirectionSchema>;
