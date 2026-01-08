/**
 * OpenRouter API Request/Response Schemas
 *
 * OpenRouter uses an OpenAI-compatible API, so we extend the OpenAI schemas
 * with OpenRouter-specific headers.
 */
import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z
    .object({
        completion_tokens: z.number(),
        prompt_tokens: z.number(),
        total_tokens: z.number(),
        completion_tokens_details: z.any().optional(),
        prompt_tokens_details: z.any().optional(),
    })
    .describe("OpenRouter usage object (OpenAI-compatible)");

export const FinishReasonSchema = z.enum([
    "stop",
    "length",
    "tool_calls",
    "content_filter",
    "function_call",
]);

const ChoiceSchema = z.object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z.object({
        content: z.string().nullable(),
        refusal: z.string().nullable().optional(),
        role: z.enum(["assistant"]),
        annotations: z.array(z.any()).optional(),
        audio: z.any().nullable().optional(),
        function_call: z
            .object({
                arguments: z.string(),
                name: z.string(),
            })
            .nullable()
            .optional(),
        tool_calls: z.array(ToolCallSchema).optional(),
    }),
});

export const ChatCompletionRequestSchema = z
    .object({
        model: z.string(),
        messages: z.array(MessageParamSchema),
        tools: z.array(ToolSchema).optional(),
        tool_choice: ToolChoiceOptionSchema.optional(),
        temperature: z.number().nullable().optional(),
        max_tokens: z.number().nullable().optional(),
        stream: z.boolean().nullable().optional(),
        // OpenRouter-specific fields
        route: z.string().optional().describe("Route preference for model selection"),
        transforms: z.array(z.string()).optional().describe("Request transforms"),
    })
    .describe("OpenRouter chat completion request (OpenAI-compatible with extensions)");

export const ChatCompletionResponseSchema = z
    .object({
        id: z.string(),
        choices: z.array(ChoiceSchema),
        created: z.number(),
        model: z.string(),
        object: z.enum(["chat.completion"]),
        system_fingerprint: z.string().nullable().optional(),
        usage: ChatCompletionUsageSchema.optional(),
    })
    .describe("OpenRouter chat completion response (OpenAI-compatible)");

/**
 * OpenRouter uses Authorization header like OpenAI, but also accepts
 * optional HTTP-Referer and X-Title headers for app attribution
 */
export const ChatCompletionsHeadersSchema = z.object({
    "user-agent": z.string().optional().describe("The user agent of the client"),
    authorization: z
        .string()
        .describe("Bearer token for OpenRouter API key")
        .transform((authorization) => authorization.replace("Bearer ", "")),
    "http-referer": z.string().optional().describe("Site URL for OpenRouter rankings"),
    "x-title": z.string().optional().describe("Site title for OpenRouter rankings"),
});
