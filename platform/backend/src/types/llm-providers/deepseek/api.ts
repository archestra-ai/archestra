import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
    prompt_cache_hit_tokens: z
      .number()
      .optional()
      .describe(`https://api-docs.deepseek.com/`),
    prompt_cache_miss_tokens: z
      .number()
      .optional()
      .describe(`https://api-docs.deepseek.com/`),
  })
  .describe(`https://api-docs.deepseek.com/`);

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
        reasoning_content: z.string().optional(),
        tool_calls: z.array(ToolCallSchema).optional(),
        function_call: z
          .object({
            arguments: z.string(),
            name: z.string(),
          })
          .nullable()
          .optional(),
      })
      .describe(`https://api-docs.deepseek.com/`),
  })
  .describe(`https://api-docs.deepseek.com/`);

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
    response_format: z
      .object({
        type: z.enum(["text", "json_object"]),
      })
      .optional(),
    frequency_penalty: z.number().nullable().optional(),
    presence_penalty: z.number().nullable().optional(),
    logprobs: z.boolean().nullable().optional(),
    top_logprobs: z.number().nullable().optional(),
  })
  .describe(`https://api-docs.deepseek.com/`);

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
  .describe(`https://api-docs.deepseek.com/`);

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .describe("Bearer token for DeepSeek")
    .transform((authorization) => authorization.replace("Bearer ", "")),
  "accept-language": z.string().optional(),
});
