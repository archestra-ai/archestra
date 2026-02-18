/**
 * Grok LLM Provider Interaction Handler - OpenAI-compatible
 * @see https://docs.x.ai/docs
 */
import OpenAiChatCompletionInteraction from "./openai";

// Grok uses the same request/response format as OpenAI
class GrokChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default GrokChatCompletionInteraction;
