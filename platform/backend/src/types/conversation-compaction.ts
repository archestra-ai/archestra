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
