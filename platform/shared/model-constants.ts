import { z } from "zod";

/**
 * Supported LLM providers
 */
export const SupportedProvidersSchema = z.enum([
  "openai",
  "anthropic",
  "gemini",
  "cohere",
  "mistral",
  "deepseek",
  "groq",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
  "anthropic:messages",
  "mistral:chat",
  "deepseek:chat",
  "groq:chat",
]);

export const SupportedProviders = Object.values(SupportedProvidersSchema.enum);
export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;
export type SupportedProviderDiscriminator = z.infer<
  typeof SupportedProvidersDiscriminatorSchema
>;

export const providerDisplayNames: Record<
  z.infer<typeof SupportedProvidersSchema>,
  string
> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  mistral: "Mistral AI",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  groq: "Groq",
};
