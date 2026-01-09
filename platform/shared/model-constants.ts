import { z } from "zod";

/**
 * Supported LLM providers
 */
export const SupportedProvidersSchema = z.enum([
  "openai",
  "gemini",
  "anthropic",
  "mistral",
  "deepseek",
  "groq",
  "minimax",
  "cohere",
  "perplexity",
  "cerebras",
  "xai",
  "zai",
  "togetherai",
  "fireworks",
  "sambanova",
  "novita",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
  "anthropic:messages",
  "mistral:chat",
  "deepseek:chat",
  "groq:chat",
  "minimax:chat",
  "perplexity:chat",
  "cerebras:chat",
  "xai:chat",
  "zai:chat",
  "togetherai:chat",
  "fireworks:chat",
  "sambanova:chat",
  "novita:chat",
]);

export const SupportedProviders = Object.values(SupportedProvidersSchema.enum);
export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;
export type SupportedProviderDiscriminator = z.infer<
  typeof SupportedProvidersDiscriminatorSchema
>;

export const providerDisplayNames: Record<SupportedProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  mistral: "Mistral AI",
  deepseek: "DeepSeek",
  groq: "Groq",
  minimax: "MiniMax",
  cohere: "Cohere",
  perplexity: "Perplexity",
  cerebras: "Cerebras",
  xai: "xAI",
  zai: "Z.ai",
  togetherai: "Together AI",
  fireworks: "Fireworks AI",
  sambanova: "SambaNova",
  novita: "Novita",
};
