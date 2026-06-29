/**
 * xAI LLM Provider Interaction Handler
 *
 * xAI provides an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://docs.x.ai/docs/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

class XaiChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default XaiChatCompletionInteraction;
