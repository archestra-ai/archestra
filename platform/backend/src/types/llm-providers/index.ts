import { z } from "zod";

export { default as Gemini } from "./gemini";
export { default as OpenAi } from "./openai";

export const SupportedProvidersSchema = z.enum(["openai", "gemini"]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
]);

export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;
export type SupportedProviderDiscriminator = z.infer<
  typeof SupportedProvidersDiscriminatorSchema
>;
