/**
 * Perplexity API schemas
 *
 * Perplexity uses an OpenAI-compatible API with some differences:
 * - This endpoint takes no `tools`/`tool_choice` — it answers `invalid request`
 *   when they are sent. Perplexity's tool calling lives on its separate Agent
 *   API instead (see inferPerplexityCapabilities in services/model-sync.ts)
 * - Has search_results field in responses (citations from web search)
 * - Has Perplexity-specific usage fields (search_context_size, citation_tokens, etc.)
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 */

import { z } from "zod";
import {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionRequestSchema as OpenAIChatCompletionRequestSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export the schemas Perplexity shares verbatim with OpenAI
export {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * Perplexity's streaming format selector.
 *
 * `full` (the API default) streams complete message objects and emits no
 * reasoning. `concise` streams deltas only and adds the `chat.reasoning` /
 * `chat.reasoning.done` chunks that carry the model's chain of thought — the
 * only way to obtain reasoning from the chat-completions endpoint.
 *
 * @see https://docs.perplexity.ai/docs/sonar/pro-search/stream-mode
 */
export const StreamModeSchema = z.enum(["full", "concise"]);

/**
 * Perplexity request schema: OpenAI-compatible plus `stream_mode`.
 */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.extend({
    stream_mode: StreamModeSchema.optional(),
  });

/**
 * Perplexity response schema with passthrough for extra fields.
 * Perplexity API returns additional fields like "citations" and "search_results"
 * that are not in the standard OpenAI schema.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
