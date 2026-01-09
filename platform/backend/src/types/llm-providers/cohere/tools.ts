import { z } from "zod";

/**
 * Cohere tool parameter definitions
 */
export const CohereToolParameterSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  required: z.array(z.string()).optional(),
  properties: z.record(z.unknown()).optional(),
});

/**
 * Cohere tool definition (function type)
 */
export const CohereToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: CohereToolParameterSchema.optional(),
  }),
});
