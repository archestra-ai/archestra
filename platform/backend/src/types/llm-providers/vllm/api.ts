/**
 * vLLM API Types
 *
 * vLLM exposes an OpenAI-compatible API server, so we re-export OpenAI schemas.
 * See: https://docs.vllm.ai/en/latest/features/openai_api.html
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
  "function_call",
]);

const ChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z
      .object({
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
        // vLLM-specific: reasoning field for models that support it
        reasoning: z.string().nullable().optional(),
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
    // vLLM-specific parameters
    top_p: z.number().nullable().optional(),
    top_k: z.number().nullable().optional(),
    frequency_penalty: z.number().nullable().optional(),
    presence_penalty: z.number().nullable().optional(),
    repetition_penalty: z.number().nullable().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    seed: z.number().nullable().optional(),
    n: z.number().nullable().optional(),
    best_of: z.number().nullable().optional(),
    logprobs: z.boolean().nullable().optional(),
    top_logprobs: z.number().nullable().optional(),
  })
  .describe("vLLM chat completion request (OpenAI-compatible)");

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
  .describe("vLLM chat completion response (OpenAI-compatible)");

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .optional()
    .describe("Bearer token for vLLM (often not required)")
    .transform((authorization) =>
      authorization ? authorization.replace("Bearer ", "") : undefined,
    ),
});
