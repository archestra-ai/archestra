import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectA2ATaskSchema = createSelectSchema(schema.a2aTasksTable);
export const InsertA2ATaskSchema = createInsertSchema(
  schema.a2aTasksTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type A2ATask = z.infer<typeof SelectA2ATaskSchema>;
export type InsertA2ATask = z.infer<typeof InsertA2ATaskSchema>;
