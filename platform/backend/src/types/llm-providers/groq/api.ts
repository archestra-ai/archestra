/**
 * Groq API schemas
 *
 * Groq uses an OpenAI-compatible API with some differences:
 * - content field is optional in responses (can be omitted when tool_calls present)
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
 * Differs from OpenAI: content is optional when tool_calls present
 * @see https://console.groq.com/docs/api-reference#chat-create
 */
const GroqChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z
      .object({
        // Groq: content is optional when tool_calls are present
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
      .describe(`https://console.groq.com/docs/api-reference#chat-create`),
  })
  .describe(`https://console.groq.com/docs/api-reference#chat-create`);

/**
 * Groq-specific ChatCompletionResponse schema
 */
export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(GroqChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    server_tier: z.string().optional(),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
  })
  .describe(`https://console.groq.com/docs/api-reference#chat-create`);
