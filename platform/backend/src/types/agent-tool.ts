import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { UuidIdSchema } from "./api";
import { ToolParametersContentSchema } from "./tool";

const ToolResultTreatmentSchema = z.enum([
  "trusted",
  "sanitize_with_dual_llm",
  "untrusted",
]);

export const SelectAgentToolSchema = createSelectSchema(
  schema.agentToolsTable,
  {
    toolResultTreatment: ToolResultTreatmentSchema,
  },
)
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
      mcpServerId: z.string().nullable(),
      mcpServerName: z.string().nullable(),
      mcpServerCatalogId: z.string().nullable(),
    }),
  });

export const InsertAgentToolSchema = createInsertSchema(
  schema.agentToolsTable,
  {
    toolResultTreatment: ToolResultTreatmentSchema,
  },
);
export const UpdateAgentToolSchema = createUpdateSchema(
  schema.agentToolsTable,
  {
    toolResultTreatment: ToolResultTreatmentSchema,
  },
);

export const AgentToolFilterSchema = z.object({
  search: z.string().optional(),
  agentId: UuidIdSchema.optional(),
  origin: z.string().optional().describe("Can be 'llm-proxy' or a catalogId"),
  mcpServerOwnerId: z
    .string()
    .optional()
    .describe("Filter by MCP server owner user ID"),
  excludeArchestraTools: z.coerce
    .boolean()
    .optional()
    .describe("For test isolation"),
});
export const AgentToolSortBySchema = z.enum([
  "name",
  "agent",
  "origin",
  "createdAt",
  "allowUsageWhenUntrustedDataIsPresent",
]);
export const AgentToolSortDirectionSchema = z.enum(["asc", "desc"]);

export type AgentTool = z.infer<typeof SelectAgentToolSchema>;
export type InsertAgentTool = z.infer<typeof InsertAgentToolSchema>;
export type UpdateAgentTool = z.infer<typeof UpdateAgentToolSchema>;

export type ToolResultTreatment = z.infer<typeof ToolResultTreatmentSchema>;

export type AgentToolFilters = z.infer<typeof AgentToolFilterSchema>;
export type AgentToolSortBy = z.infer<typeof AgentToolSortBySchema>;
export type AgentToolSortDirection = z.infer<
  typeof AgentToolSortDirectionSchema
>;

export const BulkUpdateAgentToolsRequestSchema = z.object({
  ids: z.array(UuidIdSchema).min(1, "At least one ID is required"),
  field: z.enum([
    "allowUsageWhenUntrustedDataIsPresent",
    "toolResultTreatment",
  ]),
  value: z.union([z.boolean(), ToolResultTreatmentSchema]),
  clearAutoConfigured: z.boolean().optional(),
});

export const BulkUpdateAgentToolsResponseSchema = z.object({
  updatedCount: z.number(),
});

export type BulkUpdateAgentToolsRequest = z.infer<
  typeof BulkUpdateAgentToolsRequestSchema
>;
export type BulkUpdateAgentToolsResponse = z.infer<
  typeof BulkUpdateAgentToolsResponseSchema
>;
