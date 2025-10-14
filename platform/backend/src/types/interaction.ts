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

// Keep the old InteractionContentSchema for backward compatibility during migration
const InteractionContentSchema = z.union([OpenAi.Messages.MessageParamSchema]);

/**
 * Database select schema with discriminated union
 * This ensures type safety based on provider
 */
export const SelectInteractionSchema = createSelectSchema(
  schema.interactionsTable,
  {
    request: InteractionRequestSchema,
    response: InteractionResponseSchema,
  },
).transform((data) => {
  // Transform to discriminated union for type safety
  if (data.provider === "openai") {
    return {
      ...data,
      provider: "openai" as const,
      request: data.request as z.infer<
        typeof OpenAi.API.ChatCompletionRequestSchema
      >,
      response: data.response as z.infer<
        typeof OpenAi.API.ChatCompletionResponseSchema
      >,
    };
  } else if (data.provider === "gemini") {
    return {
      ...data,
      provider: "gemini" as const,
      request: data.request as z.infer<
        typeof Gemini.API.GenerateContentRequestSchema
      >,
      response: data.response as z.infer<
        typeof Gemini.API.GenerateContentResponseSchema
      >,
    };
  }
  // Fallback for unknown providers (shouldn't happen with proper validation)
  return data;
});

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
export type InteractionContent = z.infer<typeof InteractionContentSchema>;
