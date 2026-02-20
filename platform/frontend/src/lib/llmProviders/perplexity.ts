/**
 * Perplexity LLM Provider Interaction Handler
 *
 * Perplexity uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * Note: Perplexity does NOT support external tool calling.
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 */
import OpenAiChatCompletionInteraction from "./openai";

// Perplexity uses the same request/response format as OpenAI
class PerplexityChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default PerplexityChatCompletionInteraction;
