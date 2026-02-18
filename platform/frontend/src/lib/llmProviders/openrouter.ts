/**
 * OpenRouter LLM Provider Interaction Handler - OpenAI-compatible
 * @see https://openrouter.ai/docs
 */
import OpenAiChatCompletionInteraction from "./openai";

// OpenRouter uses the same request/response format as OpenAI
class OpenRouterChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default OpenRouterChatCompletionInteraction;
