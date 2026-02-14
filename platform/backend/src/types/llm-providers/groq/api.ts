/**
 * Groq API schemas
 *
 * Groq uses an OpenAI-compatible API, so we re-export OpenAI schemas.
 * @see https://console.groq.com/docs/api-reference
 */

// Re-export schemas that are identical to OpenAI
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionResponseSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
} from "../openai/api";
