import type { PartialUIMessage } from "@/components/chatbot-demo";
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
} from "@/lib/clients/api";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

class GeminiGenerateContentInteraction implements InteractionUtils {
  private request: GeminiGenerateContentRequest;
  private response: GeminiGenerateContentResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request = interaction.request as GeminiGenerateContentRequest;
    this.response = interaction.response as GeminiGenerateContentResponse;
    this.modelName = this.response.modelVersion as string;
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.contents;

    if (messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    return lastMessage.role === "function";
  }

  // TODO: Implement this
  getLastToolCallId(): string | null {
    const messages = this.request.contents;
    if (messages.length === 0) {
      return null;
    }
    return null;
  }

  // TODO: Implement this
  getToolNamesUsed(): string[] {
    const messages = this.request.contents;
    if (messages.length === 0) {
      return [];
    }
    return [];
  }

  // TODO: Implement this
  getToolNamesRefused(): string[] {
    return [];
  }

  // TODO: Implement this
  getToolNamesRequested(): string[] {
    return [];
  }

  // TODO: Implement this
  getToolRefusedCount(): number {
    return 0;
  }

  // TODO: Implement this
  getLastUserMessage(): string {
    return "";
  }

  // TODO: Implement this
  getLastAssistantResponse(): string {
    return "";
  }

  // TODO: Implement this
  private mapToUiMessage(
    _content:
      | GeminiGenerateContentRequest["contents"][number]
      | GeminiGenerateContentResponse["candidates"][number],
  ): PartialUIMessage {
    return {
      role: "assistant",
      parts: [],
    };
  }

  private mapRequestToUiMessages(
    _dualLlmResults?: DualLlmResult[],
  ): PartialUIMessage[] {
    return this.request.contents.map((content) => this.mapToUiMessage(content));
  }

  private mapResponseToUiMessages(): PartialUIMessage[] {
    return (
      this.response?.candidates?.map((candidate) =>
        this.mapToUiMessage(candidate),
      ) ?? []
    );
  }

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    return [
      ...this.mapRequestToUiMessages(dualLlmResults),
      ...this.mapResponseToUiMessages(),
    ];
  }
}

export default GeminiGenerateContentInteraction;
