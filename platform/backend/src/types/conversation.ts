import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SupportedChatProviderSchema } from "./chat-api-key";

export const SelectConversationSchema = createSelectSchema(
  schema.conversationsTable,
).extend({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    systemPrompt: z.string().nullable(),
    userPrompt: z.string().nullable(),
    agentType: z.enum(["mcp_gateway", "agent"]),
  }),
  messages: z.array(z.any()), // UIMessage[] from AI SDK
});

export const InsertConversationSchema = createInsertSchema(
  schema.conversationsTable,
  {
    // Override selectedProvider to use the proper enum type
    selectedProvider: SupportedChatProviderSchema.nullable().optional(),
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateConversationSchema = createUpdateSchema(
  schema.conversationsTable,
  {
    // Override selectedProvider to use the proper enum type
    selectedProvider: SupportedChatProviderSchema.nullable().optional(),
  },
).pick({
  title: true,
  selectedModel: true,
  selectedProvider: true,
  chatApiKeyId: true,
  agentId: true,
  artifact: true,
});

export type Conversation = z.infer<typeof SelectConversationSchema>;
export type InsertConversation = z.infer<typeof InsertConversationSchema>;
export type UpdateConversation = z.infer<typeof UpdateConversationSchema>;
