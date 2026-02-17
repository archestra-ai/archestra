/**
 * MiniMax LLM Provider Interaction Handler
 *
 * MiniMax uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://platform.minimaxi.com/document/ChatCompletion%20v2
 */
import OpenAiChatCompletionInteraction from "./openai";

// MiniMax uses the same request/response format as OpenAI
class MiniMaxChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default MiniMaxChatCompletionInteraction;
