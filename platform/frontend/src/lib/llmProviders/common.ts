import type { archestraApiTypes } from "@shared";
import type {
  PartialUIMessage,
  PolicyDeniedPart,
} from "@/components/chatbot-demo";

export type Interaction =
  archestraApiTypes.GetInteractionsResponses["200"]["data"][number];
export type DualLlmResult =
  archestraApiTypes.GetDualLlmResultsByInteractionResponses["200"][number];

export interface RefusalInfo {
  toolName?: string;
  toolArguments?: string;
  reason?: string;
}

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

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[];
}

export function parseRefusalMessage(refusal: string): RefusalInfo {
  const toolNameMatch = refusal.match(
    /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
  );
  const toolArgsMatch = refusal.match(
    /<archestra-tool-arguments>(.*?)<\/archestra-tool-arguments>/,
  );
  const toolReasonMatch = refusal.match(
    /<archestra-tool-reason>(.*?)<\/archestra-tool-reason>/,
  );

  return {
    toolName: toolNameMatch?.[1],
    toolArguments: toolArgsMatch?.[1],
    reason: toolReasonMatch?.[1] || "Blocked by policy",
  };
}

/**
 * Parse text to PolicyDeniedPart if it matches JSON or legacy text format
 */
export function parsePolicyDenied(text: string): PolicyDeniedPart | null {
  // Try JSON format first (new format)
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.state === "output-denied" &&
      typeof parsed.type === "string" &&
      parsed.type.startsWith("tool-")
    ) {
      return parsed as PolicyDeniedPart;
    }
  } catch {
    // Not JSON, try legacy text format
  }

  // Try legacy plain text format:
  // "I tried to invoke the {toolName} tool with the following arguments: {args}.\n\nHowever, I was denied by a tool invocation policy:\n\n{reason}"
  const legacyMatch = text.match(
    /I tried to invoke the (.+?) tool with the following arguments: (.+?)\.\s*However, I was denied by a tool invocation policy:\s*([\s\S]+)/,
  );
  if (legacyMatch) {
    const [, toolName, argsStr, reason] = legacyMatch;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(argsStr);
    } catch {
      // Keep empty if parsing fails
    }
    return {
      type: `tool-${toolName}`,
      toolCallId: "",
      state: "output-denied",
      input,
      errorText: JSON.stringify({ reason: reason.trim() }),
    };
  }

  return null;
}
