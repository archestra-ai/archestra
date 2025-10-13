import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectDualLlmResultSchema = createSelectSchema(
  schema.dualLlmResultsTable,
);

export const InsertDualLlmResultSchema = createInsertSchema(
  schema.dualLlmResultsTable,
);

export type DualLlmResult = z.infer<typeof SelectDualLlmResultSchema>;
export type InsertDualLlmResult = z.infer<typeof InsertDualLlmResultSchema>;
