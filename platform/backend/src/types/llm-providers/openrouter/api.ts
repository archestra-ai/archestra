/**
 * OpenRouter API schemas - OpenAI-compatible
 *
 * OpenRouter uses an OpenAI-compatible API.
 * @see https://openrouter.ai/docs/api-reference
 */

// Re-export all schemas from OpenAI since OpenRouter is fully compatible
export {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
} from "../openai/api";
