import type { SupportedProviderDiscriminator } from "@/types";
import { GeminiGenerateContentTransformer } from "./gemini";
import { OpenAIChatCompletionsTransformer } from "./openai";

type AnyTransformer =
  | OpenAIChatCompletionsTransformer
  | GeminiGenerateContentTransformer;

const transformers: Record<SupportedProviderDiscriminator, AnyTransformer> = {
  "openai:chatCompletions": new OpenAIChatCompletionsTransformer(),
  "gemini:generateContent": new GeminiGenerateContentTransformer(),
};

export function getTransformer(
  providerDiscriminator: SupportedProviderDiscriminator,
): AnyTransformer {
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
