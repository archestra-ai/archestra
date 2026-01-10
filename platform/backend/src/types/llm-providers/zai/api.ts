/**
 * Z.ai API Schemas
 * Z.ai (Zhipu AI) uses an OpenAI-compatible API format.
 * @see https://docs.z.ai/api-reference/llm/chat-completion
 */
import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z.object({
  completion_tokens: z.number(),
  prompt_tokens: z.number(),
  total_tokens: z.number(),
  completion_tokens_details: z.any().optional(),
  prompt_tokens_details: z.any().optional(),
});

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

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageParamSchema),
  tools: z.array(ToolSchema).optional(),
  tool_choice: ToolChoiceOptionSchema.optional(),
  temperature: z.number().nullable().optional(),
  max_tokens: z.number().nullable().optional(),
  stream: z.boolean().nullable().optional(),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  choices: z.array(ChoiceSchema),
  created: z.number(),
  model: z.string(),
  object: z.enum(["chat.completion"]),
  server_tier: z.string().optional(),
  system_fingerprint: z.string().nullable().optional(),
  usage: ChatCompletionUsageSchema.optional(),
});

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .describe("Bearer token for Z.ai API")
    .transform((authorization) => authorization.replace("Bearer ", "")),
});
