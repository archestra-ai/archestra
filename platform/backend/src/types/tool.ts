import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { CredentialResolutionModeSchema } from "@/types/enterprise-managed-credentials";

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
}).extend({
  // Nullable for MCP tools
  agent: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  // Nullable for tools "sniffed" from LLM proxy requests
  catalog: z
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
  mcpServerId: z.string().nullable(),
  credentialOwnerEmail: z.string().nullable(),
  executionOwnerEmail: z.string().nullable(),
  credentialResolutionMode: CredentialResolutionModeSchema,
});

// Tool with embedded assignments schema
export const ToolWithAssignmentsSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parameters: ToolParametersContentSchema,
  catalogId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  policiesAutoConfiguredAt: z.date().nullable(),
  policiesAutoConfiguredReasoning: z.string().nullable(),
  policiesAutoConfiguredModel: z.string().nullable(),
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

export const ToolSortBy = [
  "name",
  "origin",
  "createdAt",
  "assignmentCount",
] as const;
export type ToolSortBy = (typeof ToolSortBy)[number];

export type ToolAssignment = z.infer<typeof ToolAssignmentSchema>;
export type ToolWithAssignments = z.infer<typeof ToolWithAssignmentsSchema>;
export type ToolFilters = z.infer<typeof ToolFilterSchema>;
