import type { SupportedProvider } from "@archestra/shared";
import logger from "@/logging";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import { modelFetchers } from "./index";

export async function testProviderApiKey(params: {
  provider: SupportedProvider;
  apiKey: string;
  baseUrl?: string | null;
  extraHeaders?: Record<string, string> | null;
  /**
   * The existing llm_provider_api_keys row this credential belongs to, when
   * re-testing a stored key. Lets subscription-credential fetchers persist a
   * rotated refresh token back to the row instead of discarding it.
   */
  providerApiKeyId?: string;
}): Promise<void> {
  const { provider, apiKey, baseUrl, extraHeaders, providerApiKeyId } = params;
  assertSubscriptionCredentialForProvider({ apiKey, provider });
  const models = await modelFetchers[provider](apiKey, baseUrl, extraHeaders, {
    providerApiKeyId,
  });
  if (models.length === 0) {
    logger.error({ provider }, "testProviderApiKey: Models list is empty");
    throw new Error("Models list is empty");
  }
}
