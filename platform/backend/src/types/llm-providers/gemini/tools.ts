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
 */
export const FunctionParameterSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: SchemaTypeSchema,
    format: z.string().optional(),
    description: z.string().optional(),
    nullable: z.boolean().optional(),
    enum: z.array(z.string()).optional(),
    maxItems: z.number().optional(),
    minItems: z.number().optional(),
    properties: z.record(z.string(), FunctionParameterSchema).optional(),
    required: z.array(z.string()).optional(),
    items: FunctionParameterSchema.optional(),
  }),
);

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
