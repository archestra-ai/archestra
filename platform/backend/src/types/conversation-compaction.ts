import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectConversationCompactionSchema = createSelectSchema(
  schema.conversationCompactionsTable,
);

export const InsertConversationCompactionSchema = createInsertSchema(
  schema.conversationCompactionsTable,
).omit({
  id: true,
  createdAt: true,
});

export type ConversationCompaction = z.infer<
  typeof SelectConversationCompactionSchema
>;

export type InsertConversationCompaction = z.infer<
  typeof InsertConversationCompactionSchema
>;
