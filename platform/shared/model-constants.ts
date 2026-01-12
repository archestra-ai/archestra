import { z } from "zod";

/**
 * Supported LLM providers
 */
export const SupportedProvidersSchema = z.enum([
  "openai",
  "gemini",
  "anthropic",
  "minimax",
  "cerebras",
  "vllm",
  "ollama",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
  "anthropic:messages",
  "minimax:chatCompletions",
  "cerebras:chatCompletions",
  "vllm:chatCompletions",
  "ollama:chatCompletions",
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
  minimax: "MiniMax",
  cerebras: "Cerebras",
  vllm: "vLLM",
  ollama: "Ollama",
};

/** Supported MiniMax model prefixes for filtering from API response */
export const MINIMAX_MODEL_PREFIXES = [
  "MiniMax-M2.1",
  "MiniMax-M2.1-lightning",
  "MiniMax-M2",
  "abab6-chat",
  "abab6.5-chat",
  "abab6.5s-chat",
] as const;

export type MiniMaxModelPrefix = (typeof MINIMAX_MODEL_PREFIXES)[number];

/** Check if a model ID is a supported MiniMax model */
export function isMiniMaxModel(modelId: string): boolean {
  const normalizedId = modelId.toLowerCase();
  return MINIMAX_MODEL_PREFIXES.some((prefix) =>
    normalizedId.startsWith(prefix.toLowerCase()),
  );
}
