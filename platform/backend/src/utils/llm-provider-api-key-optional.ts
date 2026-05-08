import {
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  type SupportedProvider,
} from "@shared";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";

export function isLlmProviderApiKeyOptional(
  provider: SupportedProvider,
): boolean {
  return (
    PROVIDERS_WITH_OPTIONAL_API_KEY.has(provider) ||
    (provider === "azure" && isAzureOpenAiEntraIdEnabled())
  );
}

export function getProvidersWithOptionalApiKey(): SupportedProvider[] {
  const providers = [...PROVIDERS_WITH_OPTIONAL_API_KEY];
  if (isAzureOpenAiEntraIdEnabled()) {
    providers.push("azure");
  }
  return providers;
}
