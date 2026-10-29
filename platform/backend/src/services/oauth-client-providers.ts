import { LLM_PROXY_OAUTH_SCOPE } from "@archestra/shared/oauth";
import type { ManagedOauthClient } from "@/types/managed-oauth-client";
import { resolveProviderMappings } from "./virtual-key-providers";

/** Configured mappings remain explicit overrides; automatic keys are never persisted. */
export async function resolveOauthClientProviderMappings(
  client: Pick<
    ManagedOauthClient,
    | "organizationId"
    | "grantType"
    | "scopes"
    | "includeFutureProviders"
    | "providerApiKeys"
  >,
) {
  return resolveProviderMappings({
    organizationId: client.organizationId,
    includeFutureProviders:
      client.includeFutureProviders &&
      client.grantType === "client_credentials" &&
      client.scopes.includes(LLM_PROXY_OAUTH_SCOPE),
    mappings: client.providerApiKeys,
    mapPrimary: (key) => ({
      provider: key.provider,
      providerApiKeyId: key.id,
      providerApiKeyName: key.name,
    }),
  });
}
