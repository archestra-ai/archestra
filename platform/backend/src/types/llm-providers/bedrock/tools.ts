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
// Using .passthrough() so Zod doesn't strip keys from the discriminated union.
// Without it, { any: {} } matches ToolChoiceAutoSchema (auto is optional),
// Zod strips "any", and Bedrock receives {} which it rejects.
const ToolChoiceAutoSchema = z
  .object({ auto: z.object({}).passthrough() })
  .passthrough();

const ToolChoiceAnySchema = z
  .object({ any: z.object({}).passthrough() })
  .passthrough();

const ToolChoiceToolSchema = z
  .object({
    tool: z.object({
      name: z.string(),
    }),
  })
  .passthrough();

export const ToolChoiceSchema = z.union([
  ToolChoiceToolSchema,
  ToolChoiceAnySchema,
  ToolChoiceAutoSchema,
]);

// Tool configuration
export const ToolConfigSchema = z.object({
  tools: z.array(ToolSchema),
  toolChoice: ToolChoiceSchema.optional(),
});
