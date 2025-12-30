import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectConversationSchema = createSelectSchema(
  schema.conversationsTable,
).extend({
  agent: z.object({
    id: z.string(),
    name: z.string(),
  }),
  messages: z.array(z.any()), // UIMessage[] from AI SDK
});

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
  chatApiKeyId: true,
});

export type Conversation = z.infer<typeof SelectConversationSchema>;
export type InsertConversation = z.infer<typeof InsertConversationSchema>;
export type UpdateConversation = z.infer<typeof UpdateConversationSchema>;
