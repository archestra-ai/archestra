/**
 * Perplexity API schemas
 *
 * Perplexity uses an OpenAI-compatible API with some differences:
 * - No tool calling support
 * - Has search_results field in responses (citations from web search)
 * - Has Perplexity-specific usage fields (search_context_size, citation_tokens, etc.)
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export request and other schemas from OpenAI since Perplexity is compatible
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * Perplexity response schema with passthrough for extra fields.
 * Perplexity API returns additional fields like "citations" and "search_results"
 * that are not in the standard OpenAI schema.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
