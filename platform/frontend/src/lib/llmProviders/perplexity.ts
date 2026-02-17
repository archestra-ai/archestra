/**
 * Perplexity LLM Provider Interaction Handler
 *
 * Perplexity uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://docs.perplexity.ai/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

// Perplexity uses the same request/response format as OpenAI
class PerplexityChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default PerplexityChatCompletionInteraction;
