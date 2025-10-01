import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "../database";

import { OpenAi } from "./llm-providers";

/**
 * As we support more llm provider types, this type will expand and should be updated
 */
const ToolContentSchema = z.union([OpenAi.Tools.ToolSchema]);

export const SelectToolSchema = createSelectSchema(schema.toolsTable);
export const InsertToolSchema = createInsertSchema(schema.toolsTable);

export type Tool = z.infer<typeof SelectToolSchema>;
export type InsertTool = z.infer<typeof InsertToolSchema>;

export type ToolContent = z.infer<typeof ToolContentSchema>;
