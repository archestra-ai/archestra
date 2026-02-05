import { z } from "zod";

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(`
    https://api-docs.deepseek.com/api/create-chat-completion

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
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

const FunctionToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: FunctionDefinitionSchema,
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

const NamedToolChoiceSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
    }),
  })
  .describe(`
  Specifies a tool the model should use. Use to force the model to call a specific function.

  https://api-docs.deepseek.com/api/create-chat-completion
  `);

export const ToolSchema = z.union([FunctionToolSchema]).describe(`
  A function tool that can be used to generate a response.

  https://api-docs.deepseek.com/api/create-chat-completion
  `);

export const ToolChoiceOptionSchema = z
  .union([z.enum(["none", "auto", "required"]), NamedToolChoiceSchema])
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);
