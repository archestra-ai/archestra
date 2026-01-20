import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SecretStorageTypeSchema } from "./mcp-server";

// Supported chat providers
export const SupportedChatProviderSchema = z.enum([
  "anthropic",
  "cerebras",
  "cohere",
  "gemini",
  "openai",
  "vllm",
  "ollama",
  "zhipuai",
]);
export type SupportedChatProvider = z.infer<typeof SupportedChatProviderSchema>;

// Chat API Key scope
export const ChatApiKeyScopeSchema = z.enum(["personal", "team", "org_wide"]);
export type ChatApiKeyScope = z.infer<typeof ChatApiKeyScopeSchema>;

// Chat API Key schemas
export const SelectChatApiKeySchema = createSelectSchema(
  schema.chatApiKeysTable,
).extend({
  provider: SupportedChatProviderSchema,
  scope: ChatApiKeyScopeSchema,
});

export const InsertChatApiKeySchema = createInsertSchema(
  schema.chatApiKeysTable,
)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    provider: SupportedChatProviderSchema,
    scope: ChatApiKeyScopeSchema,
  });

export const UpdateChatApiKeySchema = createUpdateSchema(
  schema.chatApiKeysTable,
)
  .omit({
    id: true,
    organizationId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    provider: SupportedChatProviderSchema.optional(),
    scope: ChatApiKeyScopeSchema.optional(),
  });

export type ChatApiKey = z.infer<typeof SelectChatApiKeySchema>;
export type InsertChatApiKey = z.infer<typeof InsertChatApiKeySchema>;
export type UpdateChatApiKey = z.infer<typeof UpdateChatApiKeySchema>;

// Response schema with scope display info
// Note: Dates are converted to ISO strings in the model for JSON serialization
// The serializerCompiler validates AFTER JSON serialization, so dates will be strings
// Note: Provider field accepts any string to handle legacy/unknown providers in the database
export const ChatApiKeyWithScopeInfoSchema = SelectChatApiKeySchema.merge(
  z.object({
    // Override provider to accept any string (for backward compatibility with existing data)
    provider: z.string(),
    // Override date fields to expect strings (after JSON serialization)
    createdAt: z.string(),
    updatedAt: z.string(),
    teamName: z.string().nullable().optional(),
    userName: z.string().nullable().optional(),
    // BYOS vault reference info (only populated when BYOS is enabled and secret is a vault reference)
    vaultSecretPath: z.string().nullable().optional(),
    vaultSecretKey: z.string().nullable().optional(),
    // Secret storage type (database, vault, external_vault, or none)
    secretStorageType: SecretStorageTypeSchema.optional(),
  }),
);

export type ChatApiKeyWithScopeInfo = z.infer<
  typeof ChatApiKeyWithScopeInfoSchema
>;
