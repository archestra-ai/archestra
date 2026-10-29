import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

/** Audio logs retain transport metadata, never a copy of the uploaded/generated audio. */
export default class AudioInteraction implements InteractionUtils {
  readonly modelName: string;
  private readonly request: {
    operation?: string;
    file?: { filename?: string; size?: number; duration_seconds?: number };
    input_characters?: number;
  };
  private readonly response: {
    bytes?: number;
    cost_available?: boolean;
    error?: unknown;
  };
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
    const file = this.request.file;
    if (!file)
      return `Audio speech: ${this.request.input_characters ?? 0} input characters`;
    const duration =
      typeof file.duration_seconds === "number"
        ? `, ${file.duration_seconds} s`
        : "";
    return `Audio ${this.request.operation}: ${file.filename} (${file.size} bytes${duration})`;
  }
  getLastAssistantResponse() {
    if (this.response.error) return "Audio request failed.";
    const returned = `Returned ${this.response.bytes ?? 0} bytes.`;
    return this.response.cost_available === false
      ? `${returned} Audio cost unavailable.`
      : returned;
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
