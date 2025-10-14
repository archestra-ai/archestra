import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { Gemini, OpenAi } from "./llm-providers";

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
  {
    request: InteractionRequestSchema,
    response: InteractionResponseSchema,
  },
);

/**
 * OpenAI-specific interaction schema for discriminated union
 */
const OpenAiInteractionSchema = BaseSelectInteractionSchema.extend({
  provider: z.literal("openai"),
  request: OpenAi.API.ChatCompletionRequestSchema,
  response: OpenAi.API.ChatCompletionResponseSchema,
});

/**
 * Gemini-specific interaction schema for discriminated union
 */
const GeminiInteractionSchema = BaseSelectInteractionSchema.extend({
  provider: z.literal("gemini"),
  request: Gemini.API.GenerateContentRequestSchema,
  response: Gemini.API.GenerateContentResponseSchema,
});

/**
 * Discriminated union schema for API responses
 * This provides type safety based on the provider field
 */
export const SelectInteractionSchema = z.discriminatedUnion("provider", [
  OpenAiInteractionSchema,
  GeminiInteractionSchema,
]);

export const InsertInteractionSchema = createInsertSchema(
  schema.interactionsTable,
  {
    request: InteractionRequestSchema,
    response: InteractionResponseSchema,
  },
);

export type Interaction = z.infer<typeof SelectInteractionSchema>;
export type InsertInteraction = z.infer<typeof InsertInteractionSchema>;

export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;
