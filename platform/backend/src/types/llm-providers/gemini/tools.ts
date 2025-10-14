import { z } from "zod";

/**
 * Schema Type for function parameters
 */
export const SchemaTypeSchema = z.enum([
  "STRING",
  "NUMBER",
  "INTEGER",
  "BOOLEAN",
  "ARRAY",
  "OBJECT",
  "NULL",
]);

/**
 * Function Parameter Schema (simplified OpenAPI 3.0 schema)
 * Represents the structure of function parameters in Gemini API
 *
 * Note: This uses z.any() for recursive properties (properties, items) to avoid
 * issues with OpenAPI schema generation. The runtime validation still works correctly,
 * but the OpenAPI docs won't show the full recursive structure.
 */
export const FunctionParameterSchema = z.object({
  type: SchemaTypeSchema,
  format: z.string().optional(),
  description: z.string().optional(),
  nullable: z.boolean().optional(),
  enum: z.array(z.string()).optional(),
  maxItems: z.number().optional(),
  minItems: z.number().optional(),
  properties: z.record(z.string(), z.any()).optional(),
  required: z.array(z.string()).optional(),
  items: z.any().optional(),
});

/**
 * Function Declaration Schema
 */
export const FunctionDeclarationSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: FunctionParameterSchema.optional(),
});

/**
 * Function Calling Mode
 */
export const FunctionCallingModeSchema = z.enum(["AUTO", "ANY", "NONE"]);

/**
 * Function Calling Config
 */
export const FunctionCallingConfigSchema = z.object({
  mode: FunctionCallingModeSchema,
  allowedFunctionNames: z.array(z.string()).optional(),
});

/**
 * Tool Config Schema
 */
export const ToolConfigSchema = z.object({
  functionCallingConfig: FunctionCallingConfigSchema,
});
