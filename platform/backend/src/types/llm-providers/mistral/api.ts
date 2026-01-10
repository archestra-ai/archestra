import { z } from "zod";

import { MessageParamSchema, ToolCallSchema } from "./messages";
import { ToolChoiceOptionSchema, ToolSchema } from "./tools";

/**
 * Mistral AI chat completions API types.
 * Mistral uses an OpenAI-compatible API format.
 * @see https://docs.mistral.ai/api/#operation/createChatCompletion
 */

export const ChatCompletionUsageSchema = z
  .object({
    completion_tokens: z.number(),
    prompt_tokens: z.number(),
    total_tokens: z.number(),
  })
  .describe("Token usage information for the request");

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "model_length",
  "error",
]);

const ChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    message: z.object({
      content: z.string().nullable(),
      role: z.enum(["assistant"]),
      tool_calls: z.array(ToolCallSchema).optional(),
    }),
  })
  .describe("A completion choice from the model");

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
    random_seed: z.number().nullable().optional(),
    safe_prompt: z.boolean().nullable().optional(),
  })
  .describe("A request to create a chat completion");

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(ChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    usage: ChatCompletionUsageSchema.optional(),
  })
  .describe("A chat completion response from Mistral");

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .describe("Bearer token for Mistral API")
    .transform((authorization) => authorization.replace("Bearer ", "")),
});
