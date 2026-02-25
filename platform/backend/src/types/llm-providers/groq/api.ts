/**
 * Groq API schemas
 *
 * Groq uses an OpenAI-compatible API at https://api.groq.com/openai/v1
 * Full tool calling support, streaming, and standard OpenAI message format.
 *
 * @see https://console.groq.com/docs/api-reference
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export request and other schemas from OpenAI since Groq is compatible
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * Groq response schema with passthrough for extra fields.
 * Groq API may return additional fields; passthrough ensures compatibility.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
