import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z.object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
});

export const FinishReasonSchema = z.enum([
    "stop",
    "length",
    "tool_calls",
    "content_filter",
]);

const ChoiceSchema = z.object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z.object({
        content: z.string().nullable(),
        role: z.enum(["assistant"]),
        tool_calls: z.array(ToolCallSchema).optional(),
    }),
});

export const ChatCompletionRequestSchema = z.object({
    model: z.string(),
    messages: z.array(MessageParamSchema),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceOptionSchema.optional(),
    temperature: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    stream: z.boolean().nullable().optional(),
    top_p: z.number().nullable().optional(),
    frequency_penalty: z.number().nullable().optional(),
    presence_penalty: z.number().nullable().optional(),
});

export const ChatCompletionResponseSchema = z.object({
    id: z.string(),
    choices: z.array(ChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    usage: ChatCompletionUsageSchema.optional(),
});

export const ChatCompletionsHeadersSchema = z.object({
    "user-agent": z.string().optional().describe("The user agent of the client"),
    authorization: z
        .string()
        .describe("Bearer token for Perplexity API")
        .transform((authorization) => authorization.replace("Bearer ", "")),
});
