import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import config from "@/config";

const AZURE_OPENAI_TOKEN_SCOPE = "https://cognitiveservices.azure.com/.default";

let azureOpenAiBearerTokenProvider: (() => Promise<string>) | null = null;

export function isAzureOpenAiEntraIdEnabled(): boolean {
  return config.llm.azure.entraIdEnabled;
}

export function getAzureOpenAiBearerTokenProvider(): () => Promise<string> {
  if (!azureOpenAiBearerTokenProvider) {
    azureOpenAiBearerTokenProvider = getBearerTokenProvider(
      new DefaultAzureCredential(),
      AZURE_OPENAI_TOKEN_SCOPE,
    );
  }

  return azureOpenAiBearerTokenProvider;
}
