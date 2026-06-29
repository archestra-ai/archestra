/**
 * OpenRouter LLM Provider Interaction Handler
 *
 * OpenRouter uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://openrouter.ai/docs/api-reference/overview
 */
import OpenAiChatCompletionInteraction from "./openai";

class OpenrouterChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default OpenrouterChatCompletionInteraction;
