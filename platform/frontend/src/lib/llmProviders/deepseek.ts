import type { DualLlmResult, Interaction, InteractionUtils } from "./common";
import OpenAiChatCompletionInteraction from "./openai";

/**
 * DeepSeek interactions are currently identical to OpenAI in structure,
 * so we can extend or reuse the OpenAI interaction logic.
 */
class DeepSeekChatInteraction extends OpenAiChatCompletionInteraction implements InteractionUtils {
    constructor(interaction: Interaction) {
        // We cast to OpenAI types because they are wire-compatible
        super(interaction);
    }
}

export default DeepSeekChatInteraction;
