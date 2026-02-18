/**
 * Groq LLM Provider Interaction Handler - OpenAI-compatible
 * @see https://console.groq.com/docs/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

// Groq uses the same request/response format as OpenAI
class GroqChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default GroqChatCompletionInteraction;
