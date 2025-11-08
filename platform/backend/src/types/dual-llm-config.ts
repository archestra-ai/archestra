import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectDualLlmConfigSchema = createSelectSchema(
  schema.dualLlmConfigsTable,
);
export const InsertDualLlmConfigSchema = createInsertSchema(
  schema.dualLlmConfigsTable,
);

export type DualLlmConfig = z.infer<typeof SelectDualLlmConfigSchema>;
export type InsertDualLlmConfig = z.infer<typeof InsertDualLlmConfigSchema>;
