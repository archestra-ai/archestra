import type { archestraApiTypes } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";
import OpenAiChatCompletionInteraction from "./openai";

export default class OpenRouterChatCompletionInteraction
  extends OpenAiChatCompletionInteraction
  implements InteractionUtils {
  // Re-use OpenAI implementation as OpenRouter is API compatible
  // If specific OpenRouter logic is needed in the future, override methods here
}
