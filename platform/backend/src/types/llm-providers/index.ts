import { z } from "zod";

export { default as Anthropic } from "./anthropic";
export { default as Gemini } from "./gemini";
export { default as OpenAi } from "./openai";

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

export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;
export type SupportedProviderDiscriminator = z.infer<
  typeof SupportedProvidersDiscriminatorSchema
>;
