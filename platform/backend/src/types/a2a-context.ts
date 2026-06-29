import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectA2AContextSchema = createSelectSchema(
  schema.a2aContextsTable,
);
export const InsertA2AContextSchema = createInsertSchema(
  schema.a2aContextsTable,
).omit({
  createdAt: true,
  updatedAt: true,
});

export type A2AContext = z.infer<typeof SelectA2AContextSchema>;
export type InsertA2AContext = z.infer<typeof InsertA2AContextSchema>;
