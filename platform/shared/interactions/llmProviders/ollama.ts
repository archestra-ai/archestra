/**
 * Ollama Interaction Utils
 *
 * Ollama exposes an OpenAI-compatible API, so we reuse the OpenAI interaction class.
 * See: https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
import OpenAiChatCompletionInteraction from "./openai";

class OllamaChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default OllamaChatCompletionInteraction;
