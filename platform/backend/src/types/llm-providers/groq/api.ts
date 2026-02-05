/**
 * Groq API types (OpenAI-compatible)
 *
 * Groq uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 */
import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

export { ChatCompletionRequestSchema, ChatCompletionsHeadersSchema };

// Use passthrough to allow Groq-specific fields
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
