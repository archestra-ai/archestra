import { z } from "zod";

/**
 * Cerebras uses OpenAI-compatible tool format
 * https://inference-docs.cerebras.ai/api-reference/chat-completions
 */

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "The parameters the function accepts, described as a JSON Schema object",
  );

const FunctionDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: FunctionDefinitionParametersSchema,
  })
  .describe("Function definition for a tool");

const FunctionToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: FunctionDefinitionSchema,
  })
  .describe("Function tool definition");

const NamedToolChoiceSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
    }),
  })
  .describe("Specifies a specific function the model should use");

export const ToolSchema = FunctionToolSchema.describe(
  "Tool definition for Cerebras chat completions API",
);

export const ToolChoiceOptionSchema = z
  .union([z.enum(["none", "auto", "required"]), NamedToolChoiceSchema])
  .describe("Controls which tool the model should use");
