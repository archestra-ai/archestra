import { ChatErrorResponseSchema } from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectConversationChatErrorSchema = createSelectSchema(
  schema.conversationChatErrorsTable,
).extend({
  error: ChatErrorResponseSchema,
});

export const InsertConversationChatErrorSchema = createInsertSchema(
  schema.conversationChatErrorsTable,
  {
    error: ChatErrorResponseSchema,
  },
).omit({
  id: true,
  createdAt: true,
});

export type ConversationChatError = z.infer<
  typeof SelectConversationChatErrorSchema
>;
export type InsertConversationChatError = z.infer<
  typeof InsertConversationChatErrorSchema
>;
