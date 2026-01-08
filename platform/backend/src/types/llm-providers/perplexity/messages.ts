import { z } from "zod";

const FunctionToolCallSchema = z.object({
    id: z.string(),
    type: z.enum(["function"]),
    function: z.object({
        arguments: z.string(),
        name: z.string(),
    }),
});

export const ToolCallSchema = FunctionToolCallSchema;

const ContentPartTextSchema = z.object({
    type: z.enum(["text"]),
    text: z.string(),
});

const SystemMessageParamSchema = z.object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["system"]),
    name: z.string().optional(),
});

const UserMessageParamSchema = z.object({
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    role: z.enum(["user"]),
    name: z.string().optional(),
});

const AssistantMessageParamSchema = z.object({
    role: z.enum(["assistant"]),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
});

const ToolMessageParamSchema = z.object({
    role: z.enum(["tool"]),
    content: z.union([z.string(), z.array(ContentPartTextSchema)]),
    tool_call_id: z.string(),
});

export const MessageParamSchema = z.union([
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
    ToolMessageParamSchema,
]);
