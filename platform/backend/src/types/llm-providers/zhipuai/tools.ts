import { z } from "zod";

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(`
    https://docs.z.ai/api-reference/llm/chat-completion#body

    The parameters the functions accepts, described as a JSON Schema object. See the
    [JSON Schema reference](https://json-schema.org/understanding-json-schema/) for
    documentation about the format.

    Omitting parameters defines a function with an empty parameter list.
  `);

const FunctionDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: FunctionDefinitionParametersSchema,
    strict: z.boolean().nullable().optional(),
  })
  .describe(`https://docs.z.ai/api-reference/llm/chat-completion#body`);

const FunctionToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: FunctionDefinitionSchema,
  })
  .describe(`https://docs.z.ai/api-reference/llm/chat-completion#body`);

const NamedToolChoiceSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
    }),
  })
  .describe(`
  Specifies a tool the model should use. Use to force the model to call a specific function.

  https://docs.z.ai/api-reference/llm/chat-completion#body
  `);

export const ToolSchema = z.union([FunctionToolSchema]).describe(`
  A function tool that can be used to generate a response.

  https://docs.z.ai/api-reference/llm/chat-completion#body
  `);

export const ToolChoiceOptionSchema = z
  .union([z.enum(["auto"]), NamedToolChoiceSchema])
  .describe(`https://docs.z.ai/api-reference/llm/chat-completion#body`);
