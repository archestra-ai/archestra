import { z } from "zod";

/**
 * Supported LLM providers
 */
export const SupportedProvidersSchema = z.enum([
  "openai",
  "gemini",
  "anthropic",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
  "anthropic:messages",
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
};

export const modelsByProvider: Record<SupportedProvider, string[]> = {
  anthropic: [
    "claude-opus-4.5",
    "claude-haiku-4.5",
    "claude-sonnet-4.5",
    "claude-opus-4.1",
    "claude-opus-4",
    "claude-sonnet-4",
    "claude-3.7-sonnet",
    "claude-3.5-haiku",
    "claude-3.5-sonnet",
    "claude-3-haiku",
    "claude-3-opus",
  ],
  openai: [
    "gpt-5.1",
    "gpt-5.1-chat",
    "gpt-5-pro",
    "gpt-5-chat",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "gpt-4",
    "o1-pro",
    "o3",
    "o3-mini",
    "o3-pro",
    "o4-mini",
  ],
  gemini: [
    "gemini-3-pro-preview",
    "gemini-3-pro-image-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-preview",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-lite-preview-09-2025",
    "gemini-2.5-pro",
    "gemini-2.5-pro-preview-tts",
  ],
};
