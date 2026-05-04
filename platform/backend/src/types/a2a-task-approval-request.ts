import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectA2ATaskApprovalRequestSchema = createSelectSchema(
  schema.a2aTaskApprovalRequestsTable,
);
export const InsertA2ATaskApprovalRequestSchema = createInsertSchema(
  schema.a2aTaskApprovalRequestsTable,
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
