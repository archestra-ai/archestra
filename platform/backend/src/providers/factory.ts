import { OpenAIProvider } from "./openai";
import type { LLMProvider } from "./types";

export type SupportedProviders = "openai";

export class LLMProviderFactory {
  static createProvider(
    provider: SupportedProviders,
    apiKey: string,
  ): LLMProvider {
    switch (provider) {
      case "openai":
        return new OpenAIProvider(apiKey);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  static isSupportedProvider(provider: string): provider is SupportedProviders {
    return ["openai"].includes(provider);
  }
}
