/**
 * vLLM Interaction Utils
 *
 * vLLM exposes an OpenAI-compatible API, so we reuse the OpenAI interaction class.
 * See: https://docs.vllm.ai/en/latest/features/openai_api.html
 */
import OpenAiChatCompletionInteraction from "./openai";

class VllmChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default VllmChatCompletionInteraction;
