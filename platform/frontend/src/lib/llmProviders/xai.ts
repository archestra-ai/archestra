/**
 * xAI (Grok) LLM Provider Interaction Handler
 *
 * xAI uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://docs.x.ai/docs/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

// xAI uses the same request/response format as OpenAI
class XaiChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default XaiChatCompletionInteraction;
