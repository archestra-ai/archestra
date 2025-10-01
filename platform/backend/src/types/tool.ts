import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "../database";

export const SelectToolSchema = createSelectSchema(schema.toolsTable);
export const InsertToolSchema = createInsertSchema(schema.toolsTable);

export type Tool = z.infer<typeof SelectToolSchema>;
export type InsertTool = z.infer<typeof InsertToolSchema>;
