import type { archestraApiTypes } from "../../index";
import type { PartialUIMessage } from "../types";

export type Interaction =
  archestraApiTypes.GetLlmProxyLogsResponses["200"]["data"][number];

/** A tool call a response asked for: the provider's id and the tool's name. */
export type RequestedToolCall = { id: string; name: string };

export interface InteractionUtils {
  modelName: string;

  /**
   * Check if the last message in an interaction is a tool message
   */
  isLastMessageToolCall(): boolean;

  /**
   * Get the tool_call_id from the last message if it's a tool message
   */
  getLastToolCallId(): string | null;

  /**
   * Get the names of the tools used in the interaction
   */
  getToolNamesUsed(): string[];

  /**
   * Get the names of the tools requested in the response (tool calls that LLM wants to execute)
   */
  getToolNamesRequested(): string[];

  /**
   * The tool calls the response requested, each with the id the provider gave
   * it, in response order. Optional: wires that correlate by name alone (or
   * request no tools) leave it out.
   */
  getToolCallsRequested?(): RequestedToolCall[];

  getLastUserMessage(): string;
  getLastAssistantResponse(): string;

  mapToUiMessages(): PartialUIMessage[];
}
