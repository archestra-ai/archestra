/**
 * XAI LLM Provider Interaction Handler
 *
 * XAI uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://console.xai.com/docs/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

// XAI uses the same request/response format as OpenAI
class XAIChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default XAIChatCompletionInteraction;
