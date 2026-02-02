import { z } from "zod";

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(`
    The parameters the functions accepts, described as a JSON Schema object.
  `);

const FunctionDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: FunctionDefinitionParametersSchema,
    strict: z.boolean().nullable().optional(),
  })
  .describe(`https://console.groq.com/docs/tool-use`);

const FunctionToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: FunctionDefinitionSchema,
  })
  .describe(`https://console.groq.com/docs/tool-use`);

const CustomToolSchema = z
  .object({
    type: z.enum(["custom"]),
    custom: z.object({
      name: z.string(),
      description: z.string().optional(),
      format: z
        .union([
          z.object({
            type: z.enum(["text"]),
          }),
          z.object({
            type: z.enum(["grammar"]),
            grammar: z.object({
              definition: z.string(),
              syntax: z.enum(["lark", "regex"]),
            }),
          }),
        ])
        .optional(),
    }),
  })
  .describe(`Custom tool`);

const NamedToolChoiceSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
    }),
  })
  .describe(`Specific tool choice`);

export const ToolSchema = z
  .union([FunctionToolSchema, CustomToolSchema])
  .describe(`https://console.groq.com/docs/tool-use`);

export const ToolChoiceOptionSchema = z
  .union([
    z.enum(["none", "auto", "required"]),
    NamedToolChoiceSchema,
    CustomToolSchema,
  ])
  .describe(`https://console.groq.com/docs/tool-use`);
