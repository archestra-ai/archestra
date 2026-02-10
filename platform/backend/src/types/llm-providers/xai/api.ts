/**
 * XAI API schemas
 *
 * XAI uses an OpenAI-compatible API with minor differences:
 * - Base URL: https://api.xai.com/openai/v1
 * - Supports tool_calls with parallel_tool_calls parameter
 * - Uses x_xai field in responses for XAI-specific metadata
 *
 * @see https://console.xai.com/docs/api-reference#chat-create
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
 * XAI-specific Choice schema
 *
 * Differs from OpenAI: content is optional (can be omitted when tool_calls present)
 * @see https://console.xai.com/docs/api-reference#chat-create
 */
const XAIChoiceSchema = z
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
        `https://console.xai.com/docs/api-reference#chat-create`,
      ),
  })
  .describe(
    `https://console.xai.com/docs/api-reference#chat-create`,
  );

/**
 * XAI-specific ChatCompletionResponse schema
 *
 * Includes x_xai field for XAI-specific metadata (request ID, etc.)
 */
export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(XAIChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
    x_xai: z
      .object({
        id: z.string().optional(),
      })
      .optional(),
  })
  .describe(
    `https://console.xai.com/docs/api-reference#chat-create`,
  );
