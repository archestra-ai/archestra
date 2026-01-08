/**
 * OpenRouter Tool Schemas
 *
 * OpenRouter uses OpenAI-compatible tool format.
 */
import { z } from "zod";

export const FunctionDefinitionParametersSchema = z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema object describing the function parameters");

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
        name: z.string().describe("The name of the custom tool"),
        description: z.string().optional().describe("Optional description of the custom tool"),
        format: z
            .union([
                z.object({
                    type: z.enum(["text"]).describe("Unconstrained text format"),
                }),
                z.object({
                    type: z.enum(["grammar"]),
                    grammar: z.object({
                        definition: z.string().describe("The grammar definition"),
                        syntax: z.enum(["lark", "regex"]).describe("The syntax of the grammar definition"),
                    }),
                }),
            ])
            .optional()
            .describe("The input format for the custom tool"),
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
