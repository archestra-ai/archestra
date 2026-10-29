import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

const OpenappaRulingSchema = z.enum(["approve", "deny"]);

export const SelectA2ATaskApprovalRequestSchema = createSelectSchema(
  schema.a2aTaskApprovalRequestsTable,
  { ruling: OpenappaRulingSchema.nullable() },
);
export const InsertA2ATaskApprovalRequestSchema = createInsertSchema(
  schema.a2aTaskApprovalRequestsTable,
  { ruling: OpenappaRulingSchema.nullish() },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type A2ATaskApprovalRequest = z.infer<
  typeof SelectA2ATaskApprovalRequestSchema
>;
export type InsertA2ATaskApprovalRequest = z.infer<
  typeof InsertA2ATaskApprovalRequestSchema
>;
