import { z } from "zod";

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

export const TextContentSchema = z.object({
    type: z.literal("text"),
    text: z.string(),
});

export const ToolCallSchema = z.object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({
        name: z.string(),
        arguments: z.string(),
    }),
});

export const AssistantMessageSchema = z.object({
    role: z.literal("assistant"),
    content: z.union([z.string(), z.array(TextContentSchema)]).optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
});

export const UserMessageSchema = z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(TextContentSchema)]),
});

export const SystemMessageSchema = z.object({
    role: z.literal("system"),
    content: z.union([z.string(), z.array(TextContentSchema)]),
});

export const ToolMessageSchema = z.object({
    role: z.literal("tool"),
    tool_call_id: z.string(),
    content: z.union([z.string(), z.array(TextContentSchema)]),
});

export const ChatMessageSchema = z.union([
    AssistantMessageSchema,
    UserMessageSchema,
    SystemMessageSchema,
    ToolMessageSchema,
]);

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
