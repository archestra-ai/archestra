/**
 * x.ai (Grok) LLM Provider Interaction Handler
 *
 * x.ai uses an OpenAI-compatible API, so we re-export the OpenAI interaction handler.
 * Models: grok-4, grok-4-1-fast-reasoning, grok-4-1-fast-non-reasoning, grok-code-fast-1
 * @see https://docs.x.ai/docs/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

// x.ai uses the same request/response format as OpenAI
class XaiChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default XaiChatCompletionInteraction;

