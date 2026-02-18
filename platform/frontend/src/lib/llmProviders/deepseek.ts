/**
 * DeepSeek LLM Provider Interaction Handler - OpenAI-compatible
 * @see https://api-docs.deepseek.com/
 */
import OpenAiChatCompletionInteraction from "./openai";

// DeepSeek uses the same request/response format as OpenAI
class DeepSeekChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default DeepSeekChatCompletionInteraction;
