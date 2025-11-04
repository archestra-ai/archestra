import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectConversationSchema = createSelectSchema(
  schema.conversationsTable,
);
export const InsertConversationSchema = createInsertSchema(
  schema.conversationsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateConversationSchema = createUpdateSchema(
  schema.conversationsTable,
).pick({
  title: true,
  selectedModel: true,
});

export type Conversation = z.infer<typeof SelectConversationSchema>;
export type InsertConversation = z.infer<typeof InsertConversationSchema>;
export type UpdateConversation = z.infer<typeof UpdateConversationSchema>;

// Conversation with messages
export const SelectConversationWithMessagesSchema =
  SelectConversationSchema.extend({
    messages: z.array(z.any()), // UIMessage[] from AI SDK
  });

export type ConversationWithMessages = z.infer<
  typeof SelectConversationWithMessagesSchema
>;
