/**
 * Z.ai Tool Schemas
 * Z.ai uses an OpenAI-compatible API for tool/function calling.
 * @see https://docs.z.ai/api-reference/llm/chat-completion
 */
import { z } from "zod";

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "The parameters the function accepts, described as a JSON Schema object.",
  );

const FunctionDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: FunctionDefinitionParametersSchema,
  strict: z.boolean().nullable().optional(),
});

const FunctionToolSchema = z.object({
  type: z.enum(["function"]),
  function: FunctionDefinitionSchema,
});

const CustomToolSchema = z.object({
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
});

const AllowedToolsSchema = z.object({
  mode: z.enum(["auto", "required"]),
  tools: z.array(z.record(z.string(), FunctionToolSchema)),
});

const AllowedToolChoiceSchema = z.object({
  type: z.enum(["allowed_tools"]),
  allowed_tools: AllowedToolsSchema,
});

const NamedToolChoiceSchema = z.object({
  type: z.enum(["function"]),
  function: z.object({
    name: z.string(),
  }),
});

export const ToolSchema = z.union([FunctionToolSchema, CustomToolSchema]);

export const ToolChoiceOptionSchema = z.union([
  z.enum(["none", "auto", "required"]),
  AllowedToolChoiceSchema,
  NamedToolChoiceSchema,
  CustomToolSchema,
]);
