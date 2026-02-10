/**
 * MiniMax LLM Provider Interaction Handler
 *
 * MiniMax uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://console.minimax.com/docs/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

// MiniMax uses the same request/response format as OpenAI
class MiniMaxChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default MiniMaxChatCompletionInteraction;
