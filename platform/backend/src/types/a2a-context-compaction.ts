import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

const SelectA2AContextCompactionSchema = createSelectSchema(
  schema.a2aContextCompactionsTable,
);

const InsertA2AContextCompactionSchema = createInsertSchema(
  schema.a2aContextCompactionsTable,
).omit({
  id: true,
  createdAt: true,
});

export type A2AContextCompaction = z.infer<
  typeof SelectA2AContextCompactionSchema
>;
export type InsertA2AContextCompaction = z.infer<
  typeof InsertA2AContextCompactionSchema
>;
