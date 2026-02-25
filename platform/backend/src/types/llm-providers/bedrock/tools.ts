import { z } from "zod";

/**
 * Bedrock Converse API tool schemas
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Tool.html
 */

// JSON Schema for tool input
const JsonSchemaSchema = z.record(z.string(), z.unknown());

// Tool specification
export const ToolSpecSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.object({
    json: JsonSchemaSchema,
  }),
});

// Tool definition
export const ToolSchema = z.object({
  toolSpec: ToolSpecSchema,
});

// Tool choice configurations
const ToolChoiceAutoSchema = z.object({
  auto: z.object({}).optional(),
});

const ToolChoiceAnySchema = z.object({
  any: z.object({}).optional(),
});

const ToolChoiceToolSchema = z.object({
  tool: z.object({
    name: z.string(),
  }),
});

export const ToolChoiceSchema = z.union([
  ToolChoiceAutoSchema,
  ToolChoiceAnySchema,
  ToolChoiceToolSchema,
]);

// Tool configuration
export const ToolConfigSchema = z.object({
  tools: z.array(ToolSchema),
  toolChoice: ToolChoiceSchema.optional(),
});
