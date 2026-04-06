/**
 * Azure AI Foundry LLM Provider Interaction Handler
 *
 * Azure AI Foundry provides an OpenAI-compatible API, so we re-use the OpenAI
 * interaction handler.
 * @see https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-reference
 */
import OpenAiChatCompletionInteraction from "./openai";

class AzureChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default AzureChatCompletionInteraction;
