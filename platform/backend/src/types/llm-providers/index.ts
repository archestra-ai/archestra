import { z } from "zod";

export { default as Gemini } from "./gemini";
export { default as OpenAi } from "./openai";

/**
 * Supported LLM Providers Schema
 */
export const SupportedProvidersSchema = z.enum(["openai", "gemini"]);

export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;
