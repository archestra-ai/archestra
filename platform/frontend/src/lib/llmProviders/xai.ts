/**
 * x.ai LLM Provider Interaction Handler
 *
 * x.ai uses an OpenAI-compatible API, so we extend the OpenAI interaction handler.
 * @see https://docs.x.ai/docs/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

class XaiChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default XaiChatCompletionInteraction;
