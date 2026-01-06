import { z } from "zod";

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(`
    The parameters the functions accepts, described as a JSON Schema object.

    Omitting parameters defines a function with an empty parameter list.
  `);

export const ToolChoiceOptionSchema = z
  .object({
    type: z.enum(["auto", "none", "required"]),
    function: z
      .object({
        name: z.string(),
      })
      .optional(),
  })
  .describe(`MiniMax tool choice option schema`);

export const ToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: FunctionDefinitionParametersSchema,
    }),
  })
  .describe(`MiniMax tool schema`);