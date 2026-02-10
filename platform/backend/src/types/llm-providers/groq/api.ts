/**
 * Groq API schemas
 *
 * Groq uses an OpenAI-compatible API with minor differences:
 * - Base URL: https://api.groq.com/openai/v1
 * - Supports tool_calls with parallel_tool_calls parameter
 * - Uses x_groq field in responses for Groq-specific metadata
 *
 * @see https://console.groq.com/docs/api-reference#chat-create
 */
import { z } from "zod";

import { ToolCallSchema } from "./messages";

// Re-export schemas that are identical to OpenAI
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
} from "../openai/api";

import { ChatCompletionUsageSchema, FinishReasonSchema } from "../openai/api";

/**
 * Groq-specific Choice schema
 *
 * Differs from OpenAI: content is optional (can be omitted when tool_calls present)
 * @see https://console.groq.com/docs/api-reference#chat-create
 */
const GroqChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z
      .object({
        content: z.string().nullable().optional(),
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
      })
      .describe(
        `https://console.groq.com/docs/api-reference#chat-create`,
      ),
  })
  .describe(
    `https://console.groq.com/docs/api-reference#chat-create`,
  );

/**
 * Groq-specific ChatCompletionResponse schema
 *
 * Includes x_groq field for Groq-specific metadata (request ID, etc.)
 */
export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(GroqChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
    x_groq: z
      .object({
        id: z.string().optional(),
      })
      .optional(),
  })
  .describe(
    `https://console.groq.com/docs/api-reference#chat-create`,
  );
