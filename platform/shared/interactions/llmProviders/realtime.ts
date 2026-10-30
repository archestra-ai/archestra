import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

/** One response of a Realtime session: logged by its transcript, never its audio. */
export default class RealtimeInteraction implements InteractionUtils {
  readonly modelName: string;
  private readonly request: {
    model?: string;
    turn?: number;
    input_transcript?: string;
  };
  private readonly response: {
    status?: string;
    output_transcript?: string;
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
    const turn = this.request.turn ? ` ${this.request.turn}` : "";
    return this.request.input_transcript
      ? `Realtime turn${turn}: ${this.request.input_transcript}`
      : `Realtime turn${turn}`;
  }
  getLastAssistantResponse() {
    if (this.response.error) return "Realtime response failed.";
    return (
      this.response.output_transcript ||
      `Realtime response ${this.response.status ?? "completed"} with no transcript.`
    );
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
