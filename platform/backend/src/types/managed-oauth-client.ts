import { OAuthClientScopeSchema } from "@archestra/shared/oauth";
import { z } from "zod";
import {
  LlmOauthClientGrantTypeSchema,
  LlmOauthClientProviderKeySchema,
  LlmOauthClientSchema,
} from "./llm-oauth-client";

export const MANAGED_OAUTH_CLIENT_METADATA_TYPE = "managed_oauth_client";
/** Legacy registrations keep their identifiers and configuration on upgrade. */
export const ManagedOauthClientMetadataSchema = z.object({
  type: z.enum([
    MANAGED_OAUTH_CLIENT_METADATA_TYPE,
    "mcp_oauth_client",
    "llm_oauth_client",
  ]),
  organizationId: z.string(),
  grantType: LlmOauthClientGrantTypeSchema.default("client_credentials"),
  authorId: z.string().nullable().default(null),
  allowedGatewayIds: z.array(z.string().uuid()).default([]),
  providerApiKeys: z.array(LlmOauthClientProviderKeySchema).default([]),
  includeFutureProviders: z.boolean().default(false),
  billingTeamId: z.string().nullable().default(null),
});
export const ManagedOauthClientSchema = LlmOauthClientSchema.extend({
  scopes: z.array(OAuthClientScopeSchema),
  allowedGatewayIds: z.array(z.string().uuid()),
  includeFutureProviders: z.boolean(),
});
export const ManagedOauthClientWithSecretSchema =
  ManagedOauthClientSchema.extend({ clientSecret: z.string() });
export type ManagedOauthClient = z.infer<typeof ManagedOauthClientSchema>;
