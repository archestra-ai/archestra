import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectConversationShareSchema = createSelectSchema(
  schema.conversationSharesTable,
);

export const InsertConversationShareSchema = createInsertSchema(
  schema.conversationSharesTable,
).omit({
  id: true,
  createdAt: true,
});

export type ConversationShare = z.infer<typeof SelectConversationShareSchema>;
export type InsertConversationShare = z.infer<
  typeof InsertConversationShareSchema
>;
