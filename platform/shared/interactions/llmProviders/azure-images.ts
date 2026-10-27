import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

/** Images are artifacts, not assistant text or executable tool calls. */
export default class AzureImagesInteraction implements InteractionUtils {
  readonly modelName: string;
  private readonly prompt: string;
  private readonly imageCount: number;
  constructor(interaction: Interaction) {
    this.modelName = interaction.model ?? "unknown";
    const request = interaction.request as { prompt?: string };
    const response = interaction.response as { data?: unknown[] };
    this.prompt = request.prompt ?? "";
    this.imageCount = response.data?.length ?? 0;
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
    return this.prompt;
  }
  getLastAssistantResponse() {
    return `Generated images: ${this.imageCount}`;
  }
  mapToUiMessages(): PartialUIMessage[] {
    return [
      { role: "user", parts: [{ type: "text", text: this.prompt }] },
      {
        role: "assistant",
        parts: [{ type: "text", text: this.getLastAssistantResponse() }],
      },
    ];
  }
}
