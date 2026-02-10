import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SupportedChatProviderSchema } from "./chat-api-key";

// Override selectedProvider to use the proper enum type
// For select schema, it's nullable (matches DB schema)
const selectExtendedFields = {
  selectedProvider: SupportedChatProviderSchema.nullable(),
};

// For insert/update schema, selectedProvider is optional
const insertUpdateExtendedFields = {
  selectedProvider: SupportedChatProviderSchema.optional(),
};

export const SelectConversationSchema = createSelectSchema(
  schema.conversationsTable,
).extend({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    systemPrompt: z.string().nullable(),
    userPrompt: z.string().nullable(),
    agentType: z.enum(["profile", "mcp_gateway", "llm_proxy", "agent"]),
    llmApiKeyId: z.string().nullable(),
  }),
  messages: z.array(z.any()), // UIMessage[] from AI SDK
  ...selectExtendedFields,
});

export const InsertConversationSchema = createInsertSchema(
  schema.conversationsTable,
  insertUpdateExtendedFields,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateConversationSchema = createUpdateSchema(
  schema.conversationsTable,
  insertUpdateExtendedFields,
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
