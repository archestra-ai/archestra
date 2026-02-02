import { z } from "zod";

import { MessageParamSchema } from "./messages";

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
  })
  .describe(`https://docs.perplexity.ai/api-reference/chat-completions`);

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "content_filter",
  "tool_calls",
]);

const ChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    message: z
      .object({
        content: z.string().nullable(),
        role: z.enum(["assistant"]),
      })
      .describe(`https://docs.perplexity.ai/api-reference/chat-completions`),
    delta: z
      .object({
        content: z.string().nullable().optional(),
        role: z.enum(["assistant"]).optional(),
      })
      .optional(),
  })
  .describe(`https://docs.perplexity.ai/api-reference/chat-completions`);

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(MessageParamSchema),
    temperature: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    stream: z.boolean().nullable().optional(),
    presence_penalty: z.number().nullable().optional(),
    frequency_penalty: z.number().nullable().optional(),
  })
  .describe(`https://docs.perplexity.ai/api-reference/chat-completions`);

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(ChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    usage: ChatCompletionUsageSchema.optional(),
  })
  .describe(`https://docs.perplexity.ai/api-reference/chat-completions`);

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .describe("Bearer token for Perplexity")
    .transform((authorization) => authorization.replace("Bearer ", "")),
});
