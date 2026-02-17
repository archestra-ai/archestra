/**
 * DeepSeek LLM Provider Interaction Handler
 *
 * DeepSeek uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 */
// DeepSeek uses the same request/response format as OpenAI
import { OpenAiChatCompletionInteraction } from "./openai";

class DeepSeekChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default DeepSeekChatCompletionInteraction;
