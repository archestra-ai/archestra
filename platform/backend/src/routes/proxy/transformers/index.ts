import type { SupportedProvider } from "@/types";
import type { ProviderTransformer } from "./common";
import { GeminiTransformer } from "./gemini";
import { OpenAITransformer } from "./openai";

const transformers: Record<SupportedProvider, ProviderTransformer> = {
  openai: new OpenAITransformer(),
  gemini: new GeminiTransformer(),
};

export function getTransformer(
  provider: SupportedProvider,
): ProviderTransformer {
  const transformer = transformers[provider];
  if (!transformer) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return transformer;
}

export { GeminiTransformer, OpenAITransformer };
