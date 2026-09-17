import type { SupportedProvider } from "@archestra/shared";
import logger from "@/logging";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";

/** Persist a definitive inference auth failure only for the rejected credential. */
export async function recordSubscriptionAuthenticationFailure(params: {
  providerApiKeyId: string;
  provider: SupportedProvider;
  matchesCredential: (stored: string) => boolean;
}): Promise<void> {
  const { providerApiKeyId, provider, matchesCredential } = params;
  try {
    const row = await LlmProviderApiKeyModel.findById(providerApiKeyId);
    if (!row?.secretId || row.provider !== provider) return;
    const stored = await getSecretValueForLlmProviderApiKey(row.secretId);
    // A reconnect may already have replaced the rejected token family.
    if (stored === undefined || !matchesCredential(stored)) return;
    await LlmProviderApiKeyModel.setRequiresReauthentication({
      id: providerApiKeyId,
      requiresReauthentication: true,
      expectedUpdatedAt: row.updatedAt,
    });
  } catch (error) {
    // Status persistence must not replace the original authentication error.
    logger.warn(
      { providerApiKeyId, error },
      "Failed to record subscription reconnect requirement",
    );
  }
}
