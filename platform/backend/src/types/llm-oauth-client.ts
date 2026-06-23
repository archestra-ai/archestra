import {
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@archestra/shared";
import { z } from "zod";

export const LLM_OAUTH_CLIENT_METADATA_TYPE = "llm_oauth_client";

/**
 * Which OAuth grant an LLM OAuth client uses:
 * - `client_credentials`: a shared application credential with no acting user.
 *   It brings its own provider keys (`providerApiKeys`) and is scoped to an
 *   explicit list of LLM proxies (`allowedLlmProxyIds`).
 * - `authorization_code`: a pre-registered client that mints user-bound tokens,
 *   so the proxy resolves the acting user's own provider keys, cost limits, and
 *   policies. The client carries no provider keys and no proxy list — the user's
 *   identity governs both — so it is identified by its `redirectUris` instead.
 */
export const LlmOauthClientGrantTypeSchema = z.enum([
  "client_credentials",
  "authorization_code",
]);
export type LlmOauthClientGrantType = z.infer<
  typeof LlmOauthClientGrantTypeSchema
>;

export const LlmOauthClientProviderKeySchema = z.object({
  provider: SupportedProvidersSchema,
  providerApiKeyId: z.string().uuid(),
});

export const LlmOauthClientMetadataSchema = z.object({
  type: z.literal(LLM_OAUTH_CLIENT_METADATA_TYPE),
  organizationId: z.string(),
  allowedLlmProxyIds: z.array(z.string().uuid()).default([]),
  providerApiKeys: z.array(LlmOauthClientProviderKeySchema).default([]),
  // Rows created before authorization_code support have no grantType; treat
  // them as the original client_credentials clients.
  grantType: LlmOauthClientGrantTypeSchema.default("client_credentials"),
});

export const LlmOauthClientSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  organizationId: z.string(),
  grantType: LlmOauthClientGrantTypeSchema,
  allowedLlmProxyIds: z.array(z.string()),
  providerApiKeys: z.array(
    LlmOauthClientProviderKeySchema.extend({
      providerApiKeyName: z.string(),
    }),
  ),
  redirectUris: z.array(z.string()),
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
  providerApiKeyId: string;
};
