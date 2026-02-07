import type { archestraApiTypes } from "@shared";
import type { Interaction, InteractionUtils } from "./common";
import OpenAiChatCompletionInteraction from "./openai";

class GroqChatCompletionInteraction
  extends OpenAiChatCompletionInteraction
  implements InteractionUtils
{
  constructor(interaction: Interaction) {
    super(interaction);
  }
}

export default GroqChatCompletionInteraction;
