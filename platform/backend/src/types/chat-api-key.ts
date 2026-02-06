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
  "bedrock",
  "cerebras",
  "cohere",
  "gemini",
  "mistral",
  "openai",
  "vllm",
  "ollama",
  "zhipuai",
]);
export type SupportedChatProvider = z.infer<typeof SupportedChatProviderSchema>;

/**
 * Type guard to check if a value is a valid SupportedChatProvider
 */
export function isSupportedChatProvider(
  value: unknown,
): value is SupportedChatProvider {
  return SupportedChatProviderSchema.safeParse(value).success;
}

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
export const ChatApiKeyWithScopeInfoSchema = SelectChatApiKeySchema.extend({
  teamName: z.string().nullable().optional(),
  userName: z.string().nullable().optional(),
  // BYOS vault reference info (only populated when BYOS is enabled and secret is a vault reference)
  vaultSecretPath: z.string().nullable().optional(),
  vaultSecretKey: z.string().nullable().optional(),
  // Secret storage type (database, vault, external_vault, or none)
  secretStorageType: SecretStorageTypeSchema.optional(),
  // Best model ID for this API key (based on is_best marker)
  bestModelId: z.string().nullable().optional(),
  // Whether this key was included because it's configured on an agent (user may not have direct access)
  isAgentKey: z.boolean().optional(),
});

export type ChatApiKeyWithScopeInfo = z.infer<
  typeof ChatApiKeyWithScopeInfoSchema
>;
