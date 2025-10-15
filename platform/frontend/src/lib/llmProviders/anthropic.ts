import type { PartialUIMessage } from "@/components/chatbot-demo";
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
} from "@/lib/clients/api";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

class AnthropicMessagesInteraction implements InteractionUtils {
  private request: AnthropicMessagesRequest;
  private response: AnthropicMessagesResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request = interaction.request as AnthropicMessagesRequest;
    this.response = interaction.response as AnthropicMessagesResponse;
    this.modelName = "claude-3-5-sonnet-20241022"; // TODO: Implement
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

  getToolNamesRefused(): string[] {
    return [];
  }

  getToolRefusedCount(): number {
    return 0;
  }

  getLastUserMessage(): string {
    return "";
  }

  getLastAssistantResponse(): string {
    return "";
  }

  mapToUiMessages(_dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    return [];
  }
}

export default AnthropicMessagesInteraction;
