import { z } from "zod";

export const CohereToolParameterSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  required: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

export const CohereToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: CohereToolParameterSchema.optional(),
  }),
});
