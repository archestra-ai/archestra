import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { UuidIdSchema } from "./api";

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

export const ToolFilterSchema = z.object({
  search: z.string().optional(),
  agentId: UuidIdSchema.optional(),
  origin: z.union([z.string(), z.enum(["llm-proxy", "mcp"])]).optional(),
  mcpServerOwnerId: z.string().optional(),
  excludeArchestraTools: z.coerce.boolean().optional(),
});

export const ToolSortBySchema = z.enum([
  "name",
  "createdAt",
  "assignedProfiles",
  "policyCount",
]);
export const ToolSortDirectionSchema = z.enum(["asc", "desc"]);

export const ToolListItemSchema = ExtendedSelectToolSchema.extend({
  assignedAgentsCount: z.number(),
  policyCount: z.number(),
});

export type Tool = z.infer<typeof SelectToolSchema>;
export type ExtendedTool = z.infer<typeof ExtendedSelectToolSchema>;
export type InsertTool = z.infer<typeof InsertToolSchema>;
export type UpdateTool = z.infer<typeof UpdateToolSchema>;

export type ToolParametersContent = z.infer<typeof ToolParametersContentSchema>;
export type ToolFilters = z.infer<typeof ToolFilterSchema>;
export type ToolSortBy = z.infer<typeof ToolSortBySchema>;
export type ToolSortDirection = z.infer<typeof ToolSortDirectionSchema>;
export type ToolListItem = z.infer<typeof ToolListItemSchema>;
