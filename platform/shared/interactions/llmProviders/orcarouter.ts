/**
 * OrcaRouter LLM Provider Interaction Handler
 *
 * OrcaRouter uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * @see https://www.orcarouter.ai
 */
import OpenAiChatCompletionInteraction from "./openai";

class OrcaRouterChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default OrcaRouterChatCompletionInteraction;
