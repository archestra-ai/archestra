import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

/** A call a provider's catch-all proxy forwarded unchanged: logged by endpoint, not by messages. */
export default class PassthroughInteraction implements InteractionUtils {
  readonly modelName: string;
  private readonly request: {
    method?: string;
    path?: string;
    query?: string;
  };
  private readonly response: {
    status?: number;
    bytes?: number;
    streamed?: boolean;
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
    const query = this.request.query ? `?${this.request.query}` : "";
    return `${this.request.method ?? "GET"} ${this.request.path ?? "/"}${query}`;
  }
  getLastAssistantResponse() {
    if (this.response.error) return "Pass-through request failed.";
    const streamed = this.response.streamed ? ", streamed" : "";
    return `${this.response.status ?? "?"}: ${this.response.bytes ?? 0} bytes${streamed}.`;
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
