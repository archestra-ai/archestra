/**
 * x.ai API schemas
 *
 * x.ai uses an OpenAI-compatible API at https://api.x.ai/v1
 * We re-export OpenAI schemas with x.ai-specific response modifications.
 *
 * @see https://docs.x.ai/docs/api-reference
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
 * Differs from OpenAI: content is optional (can be omitted when tool_calls present)
 * @see https://docs.x.ai/docs/api-reference
 */
const XaiChoiceSchema = z
  .object({
    finish_reason: FinishReasonSchema,
    index: z.number(),
    logprobs: z.any().nullable(),
    message: z
      .object({
        // x.ai: content is optional when tool_calls are present
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
      .describe("https://docs.x.ai/docs/api-reference"),
  })
  .describe("https://docs.x.ai/docs/api-reference");

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
  .describe("https://docs.x.ai/docs/api-reference");
