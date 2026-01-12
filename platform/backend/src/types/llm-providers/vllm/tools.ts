/**
 * vLLM Tool Types
 *
 * vLLM uses OpenAI-compatible tool format.
 * See: https://docs.vllm.ai/en/latest/features/tool_calling.html
 */
import { z } from "zod";

export const FunctionDefinitionParametersSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(`
    The parameters the functions accepts, described as a JSON Schema object.
    Omitting parameters defines a function with an empty parameter list.
  `);

const FunctionDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: FunctionDefinitionParametersSchema,
    strict: z.boolean().nullable().optional(),
  })
  .describe("A function definition for tool calling");

const FunctionToolSchema = z
  .object({
    type: z.enum(["function"]),
    function: FunctionDefinitionSchema,
  })
  .describe("A function tool definition");

const CustomToolSchema = z
  .object({
    type: z.enum(["custom"]),
    custom: z.object({
      name: z.string().describe("The name of the custom tool"),
      description: z.string().optional().describe("Description of the tool"),
      format: z
        .union([
          z.object({
            type: z.enum(["text"]).describe("Unconstrained text format"),
          }),
          z.object({
            type: z.enum(["grammar"]),
            grammar: z.object({
              definition: z.string().describe("The grammar definition"),
              syntax: z
                .enum(["lark", "regex"])
                .describe("The syntax of the grammar"),
            }),
          }),
        ])
        .optional()
        .describe("The input format for the custom tool"),
    }),
  })
  .describe("A custom tool definition");

const AllowedToolsSchema = z
  .object({
    mode: z.enum(["auto", "required"]).describe(`
    Constrains the tools available to the model.
    auto: allows the model to pick from allowed tools or generate a message.
    required: requires the model to call one or more of the allowed tools.
    `),
    tools: z.array(z.record(z.string(), FunctionToolSchema)),
  })
  .describe("Allowed tools configuration");

const AllowedToolChoiceSchema = z
  .object({
    type: z.enum(["allowed_tools"]),
    allowed_tools: AllowedToolsSchema,
  })
  .describe("Allowed tool choice configuration");

const NamedToolChoiceSchema = z
  .object({
    type: z.enum(["function"]),
    function: z.object({
      name: z.string(),
    }),
  })
  .describe("Named function tool choice");

export const ToolSchema = z
  .union([FunctionToolSchema, CustomToolSchema])
  .describe("A tool definition");

export const ToolChoiceOptionSchema = z
  .union([
    z.enum(["none", "auto", "required"]),
    AllowedToolChoiceSchema,
    NamedToolChoiceSchema,
    CustomToolSchema,
  ])
  .describe("Tool choice option");
