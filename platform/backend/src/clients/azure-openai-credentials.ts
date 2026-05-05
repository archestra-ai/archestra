import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import { isAzureOpenAiV1BaseUrl } from "@/clients/azure-url";
import config from "@/config";

const AZURE_OPENAI_TOKEN_SCOPE = "https://cognitiveservices.azure.com/.default";
const AZURE_AI_FOUNDRY_TOKEN_SCOPE = "https://ai.azure.com/.default";

const azureBearerTokenProviders = new Map<string, () => Promise<string>>();

export function isAzureOpenAiEntraIdEnabled(): boolean {
  return config.llm.azure.entraIdEnabled;
}

export function isAnthropicAzureFoundryEntraIdEnabled(): boolean {
  return config.llm.anthropic.azureFoundryEntraIdEnabled;
}

export function getAzureOpenAiBearerTokenProvider(
  baseUrl?: string,
): () => Promise<string> {
  return getAzureBearerTokenProvider(resolveAzureOpenAiTokenScope(baseUrl));
}

export function getAzureAiFoundryBearerTokenProvider(): () => Promise<string> {
  return getAzureBearerTokenProvider(AZURE_AI_FOUNDRY_TOKEN_SCOPE);
}

function resolveAzureOpenAiTokenScope(baseUrl?: string): string {
  return isAzureOpenAiV1BaseUrl(baseUrl)
    ? AZURE_AI_FOUNDRY_TOKEN_SCOPE
    : AZURE_OPENAI_TOKEN_SCOPE;
}

function getAzureBearerTokenProvider(scope: string): () => Promise<string> {
  let provider = azureBearerTokenProviders.get(scope);
  if (!provider) {
    provider = getBearerTokenProvider(new DefaultAzureCredential(), scope);
    azureBearerTokenProviders.set(scope, provider);
  }

  return provider;
}
