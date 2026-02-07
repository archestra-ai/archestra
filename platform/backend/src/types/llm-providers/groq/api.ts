import { z } from "zod";
import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
} from "../openai/api";

export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
} from "../openai/api";

/**
 * Groq uses standard OpenAI response format but we define it here for consistency
 */
export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  choices: z.array(
    z.object({
      finish_reason: FinishReasonSchema,
      index: z.number(),
      message: z.object({
        content: z.string().nullable().optional(),
        role: z.enum(["assistant"]),
        tool_calls: z.array(z.any()).optional(),
      }),
    }),
  ),
  created: z.number(),
  model: z.string(),
  object: z.enum(["chat.completion"]),
  usage: ChatCompletionUsageSchema.optional(),
});
