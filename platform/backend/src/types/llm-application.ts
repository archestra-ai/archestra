import { type SupportedProvider, SupportedProvidersSchema } from "@shared";
import { z } from "zod";

export const LLM_MODEL_ROUTER_SCOPE = "llm:model-router";
export const LLM_APPLICATION_METADATA_TYPE = "llm_application";

export const LlmApplicationProviderKeySchema = z.object({
  provider: SupportedProvidersSchema,
  chatApiKeyId: z.string().uuid(),
});

export const LlmApplicationMetadataSchema = z.object({
  type: z.literal(LLM_APPLICATION_METADATA_TYPE),
  organizationId: z.string(),
  allowedLlmProxyIds: z.array(z.string().uuid()).default([]),
  modelRouterProviderApiKeys: z.array(LlmApplicationProviderKeySchema),
});

export const LlmApplicationSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  organizationId: z.string(),
  allowedLlmProxyIds: z.array(z.string()),
  modelRouterProviderApiKeys: z.array(
    LlmApplicationProviderKeySchema.extend({
      chatApiKeyName: z.string(),
    }),
  ),
  disabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const LlmApplicationWithSecretSchema = LlmApplicationSchema.extend({
  clientSecret: z.string(),
});

export type LlmApplicationMetadata = z.infer<
  typeof LlmApplicationMetadataSchema
>;
export type LlmApplication = z.infer<typeof LlmApplicationSchema>;
export type LlmApplicationProviderKey = {
  provider: SupportedProvider;
  chatApiKeyId: string;
};
