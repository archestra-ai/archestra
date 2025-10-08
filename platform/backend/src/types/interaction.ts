import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { OpenAi } from "./llm-providers";

/**
 * As we support more llm provider types, this type will expand and should be updated
 */
export const InteractionRequestSchema = z.union([
  OpenAi.API.ChatCompletionRequestSchema,
]);

export const InteractionResponseSchema = z.union([
  OpenAi.API.ChatCompletionResponseSchema,
]);

// Keep the old InteractionContentSchema for backward compatibility during migration
const InteractionContentSchema = z.union([OpenAi.Messages.MessageParamSchema]);

export const SelectInteractionSchema = createSelectSchema(
  schema.interactionsTable,
  {
    request: InteractionRequestSchema,
    response: InteractionResponseSchema,
  },
);
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
