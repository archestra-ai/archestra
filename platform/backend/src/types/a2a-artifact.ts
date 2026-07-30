import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectA2AArtifactSchema = createSelectSchema(
  schema.a2aArtifactsTable,
);
export const InsertA2AArtifactSchema = createInsertSchema(
  schema.a2aArtifactsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type A2AArtifact = z.infer<typeof SelectA2AArtifactSchema>;
export type InsertA2AArtifact = z.infer<typeof InsertA2AArtifactSchema>;
