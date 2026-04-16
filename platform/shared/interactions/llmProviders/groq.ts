/**
 * Groq LLM Provider Interaction Handler
 *
 * Groq uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://console.groq.com/docs/quickstart
 */
import OpenAiChatCompletionInteraction from "./openai";

// Groq uses the same request/response format as OpenAI
class GroqChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default GroqChatCompletionInteraction;
