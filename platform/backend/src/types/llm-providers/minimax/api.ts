import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
    prompt_time: z.number().optional(),
    completion_time: z.number().optional(),
    queue_time: z.number().optional(),
    total_time: z.number().optional(),
  })
  .describe(`https://console.minimax.com/docs/api-reference#chat-create`);

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
      .describe(`https://console.minimax.com/docs/api-reference#chat-create`),
  })
  .describe(`https://console.minimax.com/docs/api-reference#chat-create`);

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
    max_completion_tokens: z.number().nullable().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    frequency_penalty: z.number().nullable().optional(),
    presence_penalty: z.number().nullable().optional(),
    n: z.number().nullable().optional(),
    seed: z.number().nullable().optional(),
    response_format: z
      .object({
        type: z.enum(["text", "json_object"]),
      })
      .optional(),
    user: z.string().optional(),
  })
  .describe(`https://console.minimax.com/docs/api-reference#chat-create`);

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(ChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
    x_minimax: z
      .object({
        id: z.string().optional(),
      })
      .optional(),
  })
  .describe(`https://console.minimax.com/docs/api-reference#chat-create`);

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .describe("Bearer token for MiniMax")
    .transform((authorization) => authorization.replace("Bearer ", "")),
  "accept-language": z.string().optional(),
});
