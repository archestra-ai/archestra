/**
 * OpenRouter LLM Provider Interaction Handler
 *
 * OpenRouter uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://openrouter.ai/docs/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

// OpenRouter uses the same request/response format as OpenAI
class OpenRouterChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default OpenRouterChatCompletionInteraction;
