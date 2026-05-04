import { type SupportedProvider, SupportedProvidersSchema } from "@shared";
import { z } from "zod";

export const LLM_OAUTH_CLIENT_METADATA_TYPE = "llm_oauth_client";

export const LlmOauthClientProviderKeySchema = z.object({
  provider: SupportedProvidersSchema,
  chatApiKeyId: z.string().uuid(),
});

export const LlmOauthClientMetadataSchema = z.object({
  type: z.literal(LLM_OAUTH_CLIENT_METADATA_TYPE),
  organizationId: z.string(),
  chatApiKeyId: z.string().uuid().nullable().default(null),
  allowedLlmProxyIds: z.array(z.string().uuid()).default([]),
  modelRouterProviderApiKeys: z.array(LlmOauthClientProviderKeySchema),
});

export const LlmOauthClientSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  organizationId: z.string(),
  chatApiKeyId: z.string().nullable(),
  chatApiKeyName: z.string().nullable(),
  chatApiKeyProvider: SupportedProvidersSchema.nullable(),
  allowedLlmProxyIds: z.array(z.string()),
  modelRouterProviderApiKeys: z.array(
    LlmOauthClientProviderKeySchema.extend({
      chatApiKeyName: z.string(),
    }),
  ),
  disabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const LlmOauthClientWithSecretSchema = LlmOauthClientSchema.extend({
  clientSecret: z.string(),
});

export type LlmOauthClientMetadata = z.infer<
  typeof LlmOauthClientMetadataSchema
>;
export type LlmOauthClient = z.infer<typeof LlmOauthClientSchema>;
export type LlmOauthClientProviderKey = {
  provider: SupportedProvider;
  chatApiKeyId: string;
};
