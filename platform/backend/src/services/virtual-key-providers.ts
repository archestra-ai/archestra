import {
  credentialRequiresPerUserScope,
  PROVIDERS_REQUIRING_BASE_URL,
} from "@archestra/shared";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";

/** Automatic access never includes personal or subscription credentials. */
export async function getSharedPrimaryProviderKeys(organizationId: string) {
  const candidates =
    await LlmProviderApiKeyModel.findSharedPrimaryKeys(organizationId);
  const keys = await Promise.all(
    candidates.map(async (key) => {
      if (
        key.requiresReauthentication ||
        (PROVIDERS_REQUIRING_BASE_URL.has(key.provider) && !key.baseUrl?.trim())
      )
        return null;
      const apiKey = key.secretId
        ? await getSecretValueForLlmProviderApiKey(key.secretId)
        : undefined;
      return credentialRequiresPerUserScope({ provider: key.provider, apiKey })
        ? null
        : key;
    }),
  );
  return keys.filter((key) => key !== null);
}

/** Explicit provider mappings take precedence over automatic shared primaries. */
export async function resolveVirtualKeyProviderMappings(
  virtualApiKeyId: string,
) {
  const key = await VirtualApiKeyModel.findById(virtualApiKeyId);
  if (!key) return [];
  const mappings =
    await VirtualApiKeyModel.getProviderApiKeysForRouting(virtualApiKeyId);
  if (key.keyType !== "standard" || !key.includeFutureProviders)
    return mappings;
  const providers = new Set(mappings.map((mapping) => mapping.provider));
  const primaries = await getSharedPrimaryProviderKeys(key.organizationId);
  return [
    ...mappings,
    ...primaries
      .filter((primary) => !providers.has(primary.provider))
      .map((primary) => ({
        provider: primary.provider,
        providerApiKeyId: primary.id,
        providerApiKeyName: primary.name,
        secretId: primary.secretId,
        scope: primary.scope,
        userId: primary.userId,
        baseUrl: primary.inferenceBaseUrl ?? primary.baseUrl,
      })),
  ];
}
