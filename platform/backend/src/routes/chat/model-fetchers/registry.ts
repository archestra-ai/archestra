import type { SupportedProvider } from "@archestra/shared";
import logger from "@/logging";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import { modelFetchers } from "./index";

export async function testProviderApiKey(
  provider: SupportedProvider,
  apiKey: string,
  baseUrl?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<void> {
  assertSubscriptionCredentialForProvider({ apiKey, provider });
  const models = await modelFetchers[provider](apiKey, baseUrl, extraHeaders);
  if (models.length === 0) {
    logger.error({ provider }, "testProviderApiKey: Models list is empty");
    throw new Error("Models list is empty");
  }
}
