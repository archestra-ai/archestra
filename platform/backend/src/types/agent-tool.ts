import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
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

export type AgentTool = z.infer<typeof SelectAgentToolSchema>;
export type InsertAgentTool = z.infer<typeof InsertAgentToolSchema>;
export type UpdateAgentTool = z.infer<typeof UpdateAgentToolSchema>;

export type ToolResultTreatment = z.infer<typeof ToolResultTreatmentSchema>;
