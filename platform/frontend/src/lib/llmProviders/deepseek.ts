/**
 * DeepSeek LLM Provider Interaction Handler
 *
 * DeepSeek uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://console.deepseek.com/docs/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

// DeepSeek uses the same request/response format as OpenAI
class DeepSeekChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default DeepSeekChatCompletionInteraction;
