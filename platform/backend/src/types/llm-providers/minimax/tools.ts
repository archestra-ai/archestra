import { z } from "zod";

// MiniMax uses OpenAI-compatible tool formats
// Reference: https://platform.minimaxi.com/document/ChatCompletion%20v2

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
  .describe("Function definition for MiniMax tools");

const FunctionToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: FunctionDefinitionSchema,
  })
  .describe("Function tool definition for MiniMax API");

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
  .describe("Tool definition for MiniMax API");

export const ToolChoiceOptionSchema = z
  .union([
    z.enum(["none", "auto", "required"]),
    NamedToolChoiceSchema,
  ])
  .describe("Tool choice option for MiniMax API");
