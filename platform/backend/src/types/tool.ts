import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "../database";
import { OpenAi } from "./llm-providers";

/**
 * As we support more llm provider types, this type will expand and should be updated
 */
const ToolParametersContentSchema = z.union([
  OpenAi.Tools.FunctionDefinitionParametersSchema,
]);

export const SelectToolSchema = createSelectSchema(schema.toolsTable, {
  parameters: ToolParametersContentSchema,
});
export const InsertToolSchema = createInsertSchema(schema.toolsTable, {
  parameters: ToolParametersContentSchema,
});

export type Tool = z.infer<typeof SelectToolSchema>;
export type InsertTool = z.infer<typeof InsertToolSchema>;

export type ToolParametersContent = z.infer<typeof ToolParametersContentSchema>;
