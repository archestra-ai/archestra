import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

/** Audio logs retain transport metadata, never a copy of the uploaded/generated audio. */
export default class AudioInteraction implements InteractionUtils {
  readonly modelName: string;
  private readonly request: {
    operation?: string;
    file?: { filename?: string; size?: number };
    input_characters?: number;
  };
  private readonly response: { bytes?: number; error?: unknown };
  constructor(interaction: Interaction) {
    this.modelName = interaction.model ?? "unknown";
    this.request = interaction.request as typeof this.request;
    this.response = interaction.response as typeof this.response;
  }
  isLastMessageToolCall() {
    return false;
  }
  getLastToolCallId() {
    return null;
  }
  getToolNamesUsed() {
    return [];
  }
  getToolNamesRequested() {
    return [];
  }
  getLastUserMessage() {
    return this.request.file
      ? `Audio ${this.request.operation}: ${this.request.file.filename} (${this.request.file.size} bytes)`
      : `Audio speech: ${this.request.input_characters ?? 0} input characters`;
  }
  getLastAssistantResponse() {
    return this.response.error
      ? "Audio request failed."
      : `Returned ${this.response.bytes ?? 0} bytes. Audio cost unavailable.`;
  }
  mapToUiMessages(): PartialUIMessage[] {
    return [
      {
        role: "user",
        parts: [{ type: "text", text: this.getLastUserMessage() }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: this.getLastAssistantResponse() }],
      },
    ];
  }
}
