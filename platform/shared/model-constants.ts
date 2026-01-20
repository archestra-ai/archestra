import { z } from "zod";

/**
 * Supported LLM providers
 */
export const SupportedProvidersSchema = z.enum([
  "openai",
  "gemini",
  "anthropic",
  "cerebras",
  "vllm",
  "ollama",
  "zhipuai",
  "cohere",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
  "anthropic:messages",
  "cerebras:chatCompletions",
  "vllm:chatCompletions",
  "ollama:chatCompletions",
  "zhipuai:chatCompletions",
  "cohere:chat",
]);

export const SupportedProviders = Object.values(SupportedProvidersSchema.enum);
export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;
export type SupportedProviderDiscriminator = z.infer<
  typeof SupportedProvidersDiscriminatorSchema
>;

export const providerDisplayNames: Record<SupportedProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  cerebras: "Cerebras",
  vllm: "vLLM",
  ollama: "Ollama",
  zhipuai: "Zhipu AI",
  cohere: "Cohere",
};
