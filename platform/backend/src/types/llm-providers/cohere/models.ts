import { z } from "zod";

/**
 * Cohere model information schema
 * @see https://docs.cohere.com/reference/list-models
 */
export const ModelSchema = z.object({
  name: z.string().describe("Unique model identifier"),
  endpoints: z.array(z.string()).optional().describe("Available endpoints for this model"),
  finetuned: z.boolean().optional().describe("Whether this is a finetuned model"),
  context_length: z.number().optional().describe("Maximum context length"),
  tokenizer_url: z.string().optional().describe("URL to the tokenizer"),
  default_endpoints: z.array(z.string()).optional().describe("Default endpoints"),
});

/**
 * List models response schema
 */
export const ListModelsResponseSchema = z.object({
  models: z.array(ModelSchema),
});
