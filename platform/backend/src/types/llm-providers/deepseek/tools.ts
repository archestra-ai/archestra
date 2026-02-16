import { z } from "zod";

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(`
    The parameters the functions accepts, described as a JSON Schema object.
    DeepSeek uses OpenAI-compatible function calling format.
    Omitting parameters defines a function with an empty parameter list.
  `);

const FunctionDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: FunctionDefinitionParametersSchema,
    strict: z.boolean().nullable().optional(),
  })
  .describe(
    "DeepSeek function definition (OpenAI-compatible format)",
  );

const FunctionToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: FunctionDefinitionSchema,
  })
  .describe(
    "DeepSeek function tool (OpenAI-compatible format)",
  );

const NamedToolChoiceSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
    }),
  })
  .describe(`
    Specifies a tool the model should use. Use to force the model to call a specific function.
  `);

export const ToolSchema = z
  .union([FunctionToolSchema])
  .describe(`
    A function tool that can be used to generate a response.
    DeepSeek supports OpenAI-compatible function calling.
  `);

export const ToolChoiceOptionSchema = z
  .union([
    z.enum(["none", "auto", "required"]),
    NamedToolChoiceSchema,
  ])
  .describe(
    "DeepSeek tool choice option (OpenAI-compatible format)",
  );