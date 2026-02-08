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
 * Parse text to PolicyDeniedPart if it matches the policy denied format
 * Example of a message:
 *
 * {
 *     "text": "\nI tried to invoke the upstash__context7__get-library-docs tool
 *     with the following arguments: {\"context7CompatibleLibraryID\":\"/websites/p5js_reference\"}.
 *     \n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked:
 *     context contains untrusted data",
 *     "type": "text",
 *     "state": "done"
 * }
 */
export function parsePolicyDenied(text: string): PolicyDeniedPart | null {
  // Unwrap AI SDK error format: {originalError: {message: "..."}}
  let actualText = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed.originalError?.message) {
      actualText = parsed.originalError.message;
    } else if (parsed.message) {
      actualText = parsed.message;
    }
  } catch {
    // Not JSON, use as-is
  }

  // Check for policy denial keywords
  const lowerText = actualText.toLowerCase();
  const hasKeywords =
    lowerText.includes("denied") &&
    lowerText.includes("tool") &&
    lowerText.includes("invocation") &&
    lowerText.includes("policy");

  if (!hasKeywords) {
    return null;
  }

  // Extract tool name and JSON arguments
  const match = actualText.match(
    /invoke[d]?\s+(?:the\s+)?(.+?)\s+tool[\s\S]*?(\{[\s\S]*?\})[\s\S]*?(?:denied|blocked)[\s\S]*?:\s*([\s\S]+)/i,
  );
  if (match) {
    const [, toolName, argsStr, reason] = match;
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

export interface AuthRequiredResult {
  catalogName: string;
  installUrl: string;
}

/**
 * Parse error text to detect "Authentication required" errors from MCP tool calls.
 * The error can arrive as:
 * - Direct text: `Authentication required for "jira-atlassian-remote".\n\nNo credentials...visit: <URL>\n\n...`
 * - Wrapped JSON: `{"code":"unknown",...,"originalError":{"message":"Authentication required..."}}`
 */
export function parseAuthRequired(
  errorText: string,
): AuthRequiredResult | null {
  let message = errorText;
  try {
    const json = JSON.parse(errorText);
    message = json?.originalError?.message || json?.message || errorText;
  } catch {
    /* not JSON, use raw text */
  }

  if (!message.includes("Authentication required for")) return null;

  const nameMatch = message.match(/Authentication required for "([^"]+)"/);
  const urlMatch = message.match(/visit:\s*(https?:\/\/\S+)/);
  if (!nameMatch || !urlMatch) return null;

  return { catalogName: nameMatch[1], installUrl: urlMatch[1] };
}
