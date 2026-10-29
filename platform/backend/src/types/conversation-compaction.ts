import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const ConversationCompactionTriggerSchema = z.enum(["auto", "manual"]);

export type ConversationCompactionTrigger = z.infer<
  typeof ConversationCompactionTriggerSchema
>;

export const SelectConversationCompactionSchema = createSelectSchema(
  schema.conversationCompactionsTable,
).extend({
  trigger: ConversationCompactionTriggerSchema,
});

export const InsertConversationCompactionSchema = createInsertSchema(
  schema.conversationCompactionsTable,
)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    trigger: ConversationCompactionTriggerSchema,
  });

export type ConversationCompaction = z.infer<
  typeof SelectConversationCompactionSchema
>;
export type InsertConversationCompaction = z.infer<
  typeof InsertConversationCompactionSchema
>;

export const ContextCompactionStatusSchema = z.enum([
  "created",
  "existing",
  "skipped",
  "failed",
]);

export type ContextCompactionStatus = z.infer<
  typeof ContextCompactionStatusSchema
>;

export const ContextCompactionReasonSchema = z.enum([
  "below_threshold",
  "using_existing_summary",
  "nothing_to_compact",
  "missing_boundary_message_id",
  "not_beneficial",
  "aborted",
  "summary_generation_failed",
]);

export type ContextCompactionReason = z.infer<
  typeof ContextCompactionReasonSchema
>;
