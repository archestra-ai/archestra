import type { SupportedProvider } from "@/types";
import type { ProviderConverter } from "../types/common";
import { GeminiConverter } from "./gemini";
import { OpenAIConverter } from "./openai";

const converters: Record<SupportedProvider, ProviderConverter> = {
  openai: new OpenAIConverter(),
  gemini: new GeminiConverter(),
};

export function getConverter(provider: SupportedProvider): ProviderConverter {
  const converter = converters[provider];
  if (!converter) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return converter;
}

export { GeminiConverter, OpenAIConverter };