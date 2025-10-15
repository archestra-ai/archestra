import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import {
  Gemini,
  OpenAi,
  SupportedProvidersDiscriminatorSchema,
} from "./llm-providers";

/**
 * Request/Response schemas that accept any provider type
 * These are used for the database schema definition
 */
export const InteractionRequestSchema = z.union([
  OpenAi.API.ChatCompletionRequestSchema,
  Gemini.API.GenerateContentRequestSchema,
]);

export const InteractionResponseSchema = z.union([
  OpenAi.API.ChatCompletionResponseSchema,
  Gemini.API.GenerateContentResponseSchema,
]);

/**
 * Base database schema without discriminated union
 * This is what Drizzle actually returns from the database
 */
const BaseSelectInteractionSchema = createSelectSchema(
  schema.interactionsTable,
);

/**
 * OpenAI-specific interaction schema for discriminated union
 */
const OpenAiChatCompletionsInteractionSchema =
  BaseSelectInteractionSchema.extend({
    type: z.enum(["openai:chatCompletions"]),
    request: OpenAi.API.ChatCompletionRequestSchema,
    response: OpenAi.API.ChatCompletionResponseSchema,
  });

/**
 * Gemini-specific interaction schema for discriminated union
 */
const GeminiGenerateContentInteractionSchema =
  BaseSelectInteractionSchema.extend({
    type: z.enum(["gemini:generateContent"]),
    request: Gemini.API.GenerateContentRequestSchema,
    response: Gemini.API.GenerateContentResponseSchema,
  });

/**
 * Discriminated union schema for API responses
 * This provides type safety based on the type field
 */
export const SelectInteractionSchema = z.discriminatedUnion("type", [
  OpenAiChatCompletionsInteractionSchema,
  GeminiGenerateContentInteractionSchema,
]);

export const InsertInteractionSchema = createInsertSchema(
  schema.interactionsTable,
  {
    type: SupportedProvidersDiscriminatorSchema,
    request: InteractionRequestSchema,
    response: InteractionResponseSchema,
  },
);

export type Interaction = z.infer<typeof SelectInteractionSchema>;
export type InsertInteraction = z.infer<typeof InsertInteractionSchema>;

export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;
