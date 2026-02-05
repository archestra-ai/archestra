/**
 * DeepSeek API types (OpenAI-compatible)
 *
 * DeepSeek uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 */
import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

export { ChatCompletionRequestSchema, ChatCompletionsHeadersSchema };

// Use passthrough to allow DeepSeek-specific fields
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
