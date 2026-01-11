/**
 * Perplexity API Types
 *
 * Perplexity exposes an OpenAI-compatible API at https://api.perplexity.ai
 * See: https://docs.perplexity.ai/api-reference/chat-completions-post
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
  .describe("Token usage statistics for the completion");

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
]);

const ChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z
      .object({
        content: z.string().nullable(),
        role: z.enum(["assistant"]),
        tool_calls: z.array(ToolCallSchema).optional(),
      })
      .describe("The assistant message in the response"),
  })
  .describe("A choice in the chat completion response");

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(MessageParamSchema),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceOptionSchema.optional(),
    temperature: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    stream: z.boolean().nullable().optional(),
    // Perplexity-specific parameters
    top_p: z.number().nullable().optional(),
    top_k: z.number().nullable().optional(),
    frequency_penalty: z.number().nullable().optional(),
    presence_penalty: z.number().nullable().optional(),
    // Perplexity search-specific parameters
    search_domain_filter: z.array(z.string()).optional(),
    return_images: z.boolean().optional(),
    return_related_questions: z.boolean().optional(),
    search_recency_filter: z.enum(["month", "week", "day", "hour"]).optional(),
  })
  .describe("Perplexity chat completion request (OpenAI-compatible)");

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(ChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
    // Perplexity-specific response fields
    citations: z.array(z.string()).optional(),
  })
  .describe("Perplexity chat completion response (OpenAI-compatible)");

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .optional()
    .describe("Bearer token for Perplexity API")
    .transform((authorization) =>
      authorization ? authorization.replace("Bearer ", "") : undefined,
    ),
});
