import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
    prompt_cache_hit_tokens: z.number().optional(),
    prompt_cache_miss_tokens: z.number().optional(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: z.number().optional(),
      })
      .optional(),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

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
        reasoning_content: z.string().nullable().optional(),
        tool_calls: z.array(ToolCallSchema).optional(),
      })
      .describe(`https://api-docs.deepseek.com/api/create-chat-completion`),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(MessageParamSchema),
    tools: z.array(ToolSchema).optional(),
    tool_choice: ToolChoiceOptionSchema.optional(),
    stream: z.boolean().optional(),
    temperature: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    frequency_penalty: z.number().nullable().optional(),
    presence_penalty: z.number().nullable().optional(),
    logprobs: z.boolean().optional(),
    top_logprobs: z.number().nullable().optional(),
    response_format: z
      .object({
        type: z.enum(["text", "json_object"]),
      })
      .optional(),
  })
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

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
  .describe(`https://api-docs.deepseek.com/api/create-chat-completion`);

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .describe("Bearer token for DeepSeek")
    .transform((authorization) => authorization.replace("Bearer ", "")),
  "accept-language": z.string().optional(),
});
