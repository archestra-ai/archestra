import { z } from "zod";

export const FunctionDefinitionParametersSchema = z
    .record(z.string(), z.unknown())
    .optional();

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

const NamedToolChoiceSchema = z.object({
    type: z.enum(["function"]),
    function: z.object({
        name: z.string(),
    }),
});

export const ToolSchema = FunctionToolSchema;

export const ToolChoiceOptionSchema = z.union([
    z.enum(["none", "auto", "required"]),
    NamedToolChoiceSchema,
]);
