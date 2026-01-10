import { z } from "zod";

// x.ai uses OpenAI-compatible tool formats
// Reference: https://docs.x.ai/api/endpoints#chat-completions

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(`
    The parameters the function accepts, described as a JSON Schema object.
    Omitting parameters defines a function with an empty parameter list.
  `);

const FunctionDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: FunctionDefinitionParametersSchema,
    strict: z.boolean().nullable().optional(),
  })
  .describe("Function definition for x.ai tools");

const FunctionToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: FunctionDefinitionSchema,
  })
  .describe("Function tool definition for x.ai API");

const NamedToolChoiceSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
    }),
  })
  .describe("Specifies a specific function the model should call");

export const ToolSchema = z
  .union([FunctionToolSchema])
  .describe("Tool definition for x.ai API");

export const ToolChoiceOptionSchema = z
  .union([
    z.enum(["none", "auto", "required"]),
    NamedToolChoiceSchema,
  ])
  .describe("Tool choice option for x.ai API");
