/**
 * MiniMax LLM Provider Interaction Handler
 *
 * MiniMax uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://www.minimaxi.com/en/document/guides/chat-completion/chat
 */
import OpenAiChatCompletionInteraction from "./openai";

// MiniMax uses the same request/response format as OpenAI
class MinimaxChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default MinimaxChatCompletionInteraction;
