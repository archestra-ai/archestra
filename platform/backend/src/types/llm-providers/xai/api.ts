/**
 * x.ai API schemas
 *
 * x.ai uses an OpenAI-compatible API.
 *
 * @see https://docs.x.ai/api
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
 * x.ai-specific Choice schema
 *
 * @see https://docs.x.ai/api/endpoints#chat-completions
 */
const XaiChoiceSchema = z
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
      .describe(`https://docs.x.ai/api/endpoints#chat-completions`),
  })
  .describe(`https://docs.x.ai/api/endpoints#chat-completions`);

/**
 * x.ai-specific ChatCompletionResponse schema
 */
export const ChatCompletionResponseSchema = z
  .object({
    id: z.string(),
    choices: z.array(XaiChoiceSchema),
    created: z.number(),
    model: z.string(),
    object: z.enum(["chat.completion"]),
    server_tier: z.string().optional(),
    system_fingerprint: z.string().nullable().optional(),
    usage: ChatCompletionUsageSchema.optional(),
  })
  .describe(`https://docs.x.ai/api/endpoints#chat-completions`);
