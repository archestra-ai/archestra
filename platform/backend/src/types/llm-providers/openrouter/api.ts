import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
  })
  .passthrough()
  .describe(`https://openrouter.ai/docs/responses`);

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "function_call",
  "content_filter",
]);

const ChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema.nullable().optional(),
    index: z.number(),
    logprobs: z.any().nullable().optional(),
    message: z
      .object({
        content: z.string().nullable(),
        role: z.enum(["assistant"]),
        tool_calls: z.array(ToolCallSchema).optional(),
        function_call: z
          .object({
            arguments: z.string(),
            name: z.string(),
          })
          .nullable()
          .optional(),
      })
      .passthrough()
      .describe(`https://openrouter.ai/docs/responses`),
  })
  .passthrough()
  .describe(`https://openrouter.ai/docs/responses`);

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
    user: z.string().optional(),
    seed: z.number().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    logit_bias: z.record(z.string(), z.number()).optional(),
  })
  .describe(`https://openrouter.ai/docs/requests`);

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(ChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.string(), // "chat.completion" usually
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
  })
  .passthrough()
  .describe(`https://openrouter.ai/docs/responses`);

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional(),
  authorization: z
    .string()
    .describe("Bearer token")
    .transform((authorization) => authorization.replace("Bearer ", "")),
  "http-referer": z.string().optional().describe("OpenRouter requirement"),
  "x-title": z.string().optional().describe("OpenRouter requirement"),
});
