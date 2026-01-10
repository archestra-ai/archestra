import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

// x.ai API schemas (OpenAI-compatible)
// Reference: https://docs.x.ai/api/endpoints#chat-completions

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
    completion_tokens_details: z.any().optional(),
    prompt_tokens_details: z.any().optional(),
  })
  .describe("Token usage information from x.ai API");

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
        refusal: z.string().nullable().optional(),
        role: z.enum(["assistant"]),
        tool_calls: z.array(ToolCallSchema).optional(),
      })
      .describe("Assistant message in response"),
  })
  .describe("Choice in x.ai chat completion response");

export const ChatCompletionRequestSchema = z
  .object({
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
    n: z.number().nullable().optional(),
    stop: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    seed: z.number().nullable().optional(),
  })
  .describe("Request body for x.ai chat completions API");

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
  .describe("Response from x.ai chat completions API");

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .describe("Bearer token for x.ai API")
    .transform((authorization) => authorization.replace("Bearer ", "")),
});

// Streaming chunk schema
const StreamDeltaSchema = z.object({
  role: z.enum(["assistant"]).optional(),
  content: z.string().nullable().optional(),
  tool_calls: z
    .array(
      z.object({
        index: z.number(),
        id: z.string().optional(),
        type: z.enum(["function"]).optional(),
        function: z
          .object({
            name: z.string().optional(),
            arguments: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

const StreamChoiceSchema = z.object({
  index: z.number(),
  delta: StreamDeltaSchema,
  finish_reason: FinishReasonSchema.nullable(),
  logprobs: z.any().nullable().optional(),
});

export const ChatCompletionChunkSchema = z
  .object({
    id: z.string(),
    object: z.enum(["chat.completion.chunk"]),
    created: z.number(),
    model: z.string(),
    system_fingerprint: z.string().nullable().optional(),
    choices: z.array(StreamChoiceSchema),
    usage: ChatCompletionUsageSchema.nullable().optional(),
  })
  .describe("Streaming chunk from x.ai chat completions API");
