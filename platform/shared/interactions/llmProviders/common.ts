import type { archestraApiTypes } from "../../index";
import type { PartialUIMessage } from "../types";

export type Interaction =
  archestraApiTypes.GetInteractionsResponses["200"]["data"][number];
export type DualLlmAnalysis = NonNullable<
  Interaction["dualLlmAnalyses"]
>[number];

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

  getToolNamesRefused(): string[];

  /**
   * Get the names of the tools requested in the response (tool calls that LLM wants to execute)
   */
  getToolNamesRequested(): string[];

  getToolRefusedCount(): number;

  getLastUserMessage(): string;
  getLastAssistantResponse(): string;

  mapToUiMessages(dualLlmAnalyses?: DualLlmAnalysis[]): PartialUIMessage[];
}
