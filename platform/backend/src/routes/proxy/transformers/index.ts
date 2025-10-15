import type { SupportedProviderDiscriminator } from "@/types";
import type { ProviderTransformer } from "./common";
import { GeminiGenerateContentTransformer } from "./gemini";
import { OpenAIChatCompletionsTransformer } from "./openai";

const transformers: Record<
  SupportedProviderDiscriminator,
  ProviderTransformer
> = {
  "openai:chatCompletions": new OpenAIChatCompletionsTransformer(),
  "gemini:generateContent": new GeminiGenerateContentTransformer(),
};

export function getTransformer(
  providerDiscriminator: SupportedProviderDiscriminator,
): ProviderTransformer {
  const transformer = transformers[providerDiscriminator];
  if (!transformer) {
    throw new Error(
      `Unsupported provider discriminator: ${providerDiscriminator}`,
    );
  }
  return transformer;
}

export type {
  GeminiGenerateContentTransformer,
  OpenAIChatCompletionsTransformer,
};
