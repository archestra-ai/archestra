/**
 * Archestra API schemas - OpenAI-compatible
 *
 * The "archestra" provider targets another Archestra instance's LLM proxy,
 * whose chat-completions endpoint is OpenAI-compatible. We reuse OpenAI schemas
 * and use .passthrough() on request/response so any upstream-specific fields
 * (e.g. reasoning_content, token details) are preserved end to end.
 */

import {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionRequestSchema as OpenAIChatCompletionRequestSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export headers and other schemas from OpenAI
export {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/** Request schema with passthrough for any upstream-forwarded params. */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/** Response schema with passthrough for reasoning_content, token details, etc. */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
