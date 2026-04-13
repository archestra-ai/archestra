/**
 * Mistral LLM Provider Interaction Handler
 *
 * Mistral uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://docs.mistral.ai/api
 */
import OpenAiChatCompletionInteraction from "./openai";

// Mistral uses the same request/response format as OpenAI
class MistralChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default MistralChatCompletionInteraction;
