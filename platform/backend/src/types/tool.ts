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
const ToolParametersContentSchema = z.union([
  OpenAi.Tools.FunctionDefinitionParametersSchema,
]);

export const ToolResultTreatmentSchema = z.enum([
  "trusted",
  "sanitize_with_dual_llm",
  "untrusted",
]);

export const SelectToolSchema = createSelectSchema(schema.toolsTable, {
  parameters: ToolParametersContentSchema,
  toolResultTreatment: ToolResultTreatmentSchema,
});

export const SelectToolWithAgentSchema = SelectToolSchema.omit({
  agentId: true,
}).extend({
  agent: z.object({
    id: z.string(),
    name: z.string(),
  }),
});

export const InsertToolSchema = createInsertSchema(schema.toolsTable, {
  parameters: ToolParametersContentSchema,
  toolResultTreatment: ToolResultTreatmentSchema.optional(),
});
export const UpdateToolSchema = createUpdateSchema(schema.toolsTable, {
  parameters: ToolParametersContentSchema.optional(),
  toolResultTreatment: ToolResultTreatmentSchema.optional(),
});

export type Tool = z.infer<typeof SelectToolSchema>;
export type ToolWithAgent = z.infer<typeof SelectToolWithAgentSchema>;
export type InsertTool = z.infer<typeof InsertToolSchema>;
export type UpdateTool = z.infer<typeof UpdateToolSchema>;

export type ToolParametersContent = z.infer<typeof ToolParametersContentSchema>;
export type ToolResultTreatment = z.infer<typeof ToolResultTreatmentSchema>;
