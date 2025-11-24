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
