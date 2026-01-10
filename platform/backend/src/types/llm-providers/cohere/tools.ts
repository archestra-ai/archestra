import { z } from "zod";

/**
 * JSON Schema for tool parameters
 */
const ParameterDefinitionSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

/**
 * Cohere tool definition schema
 */
export const ToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

/**
 * Tool call schema (from assistant response)
 */
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

/**
 * Tool result schema (for tool messages)
 */
export const ToolResultSchema = z.object({
  call: z.object({
    name: z.string(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
  outputs: z.array(z.record(z.string(), z.unknown())),
});
