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
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
  "anthropic:messages",
  "mistral:chat",
  "deepseek:chat",
  "groq:chat",
  "minimax:chat",
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
};
