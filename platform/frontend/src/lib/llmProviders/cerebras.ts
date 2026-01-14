/**
 * Cerebras LLM Provider Interaction Handler
 *
 * Cerebras uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://inference-docs.cerebras.ai/
 */
import OpenAiChatCompletionInteraction from "./openai";

// Cerebras uses the same request/response format as OpenAI
class CerebrasChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default CerebrasChatCompletionInteraction;
