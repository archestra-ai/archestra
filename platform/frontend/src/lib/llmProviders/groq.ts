import type { archestraApiTypes } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";
import OpenAiChatCompletionInteraction from "./openai";

class GroqChatCompletionInteraction extends OpenAiChatCompletionInteraction {
  constructor(interaction: Interaction) {
    super(interaction);
    (this as any).provider = "groq";
  }
}

export default GroqChatCompletionInteraction;
