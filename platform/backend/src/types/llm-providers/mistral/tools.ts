import { z } from "zod";

/**
 * Mistral AI tool types for chat completions API.
 * Mistral uses an OpenAI-compatible API format for tools.
 * @see https://docs.mistral.ai/capabilities/function_calling/
 */

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "The parameters the function accepts, described as a JSON Schema object.",
  );

const FunctionDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: FunctionDefinitionParametersSchema,
  })
  .describe("A function definition for tool use");

const FunctionToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: FunctionDefinitionSchema,
  })
  .describe("A function tool definition");

const NamedToolChoiceSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
    }),
  })
  .describe("Force the model to call a specific function");

export const ToolSchema = FunctionToolSchema.describe(
  "A tool that can be used by the model",
);

export const ToolChoiceOptionSchema = z
  .union([z.enum(["none", "auto", "any"]), NamedToolChoiceSchema])
  .describe("Controls how the model uses tools");
