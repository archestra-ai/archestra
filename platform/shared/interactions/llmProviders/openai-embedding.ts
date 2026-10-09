import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

/**
 * Interaction class for OpenAI embedding API calls.
 * Embeddings have no messages, tool calls, or conversational content —
 * all methods return empty/default values.
 */
class OpenAiEmbeddingInteraction implements InteractionUtils {
  modelName: string;

  constructor(interaction: Interaction) {
    this.modelName = interaction.model ?? "unknown";
  }

  isLastMessageToolCall(): boolean {
    return false;
  }

  getLastToolCallId(): string | null {
    return null;
  }

  getToolNamesUsed(): string[] {
    return [];
  }

  getToolNamesRequested(): string[] {
    return [];
  }

  getLastUserMessage(): string {
    return "";
  }

  getLastAssistantResponse(): string {
    return "";
  }

  mapToUiMessages(): PartialUIMessage[] {
    return [];
  }
}

export default OpenAiEmbeddingInteraction;
