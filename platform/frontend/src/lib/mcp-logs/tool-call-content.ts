import {
  type EncryptedChatRedactedContent,
  type EncryptedChatSealedContent,
  extractMcpExecutedAs,
  isEncryptedChatUnavailableContent,
  isLogContentNotStored,
  type McpExecutedAs,
  parseFullToolName,
} from "@archestra/shared";
import {
  canShowMcpToolCallStatus,
  resolveMcpToolCallStatus,
} from "./tool-call-status";

type UnavailableContent =
  | EncryptedChatSealedContent
  | EncryptedChatRedactedContent;

export type McpToolCallOutcomeStatus =
  | "success"
  | "error"
  | "cancelled"
  | "unknown";

/**
 * What one logged MCP call recorded, with the unavailable cases split out
 * before anything reads a field off them.
 *
 * An encrypted chat's call and result are stored encrypted (or, failing
 * closed, not at all), so the columns hold a sentinel rather than the recorded
 * content: the tool name, the arguments and the outcome are all equally
 * unavailable, and painting the call "Success" would be a claim the row does
 * not support. The redaction fallback nests the marker in `arguments` instead
 * of replacing the whole call, so both shapes resolve to "unavailable". A
 * Metadata only row withholds the arguments and the result but keeps the
 * tool's name and the call's outcome in its marker.
 */
export function readMcpToolCall(row: {
  method: string | null;
  toolCall: unknown;
  toolResult: unknown;
}): {
  method: string;
  /** The tool's own name, without its server prefix; null for non-tool methods. */
  toolName: string | null;
  /** The recorded arguments, or `undefined` when none were recorded. */
  args: unknown;
  lockedArgs: UnavailableContent | null;
  result: { isError?: boolean; error?: string; content?: unknown } | null;
  lockedResult: UnavailableContent | null;
  status: McpToolCallOutcomeStatus;
  /** Whose credential served the call upstream, recorded with the result. */
  executedAs: McpExecutedAs | null;
} {
  const method = row.method || "tools/call";
  const nestedArgs = (row.toolCall as { arguments?: unknown } | null)
    ?.arguments;
  const lockedArgs = isEncryptedChatUnavailableContent(row.toolCall)
    ? row.toolCall
    : isEncryptedChatUnavailableContent(nestedArgs)
      ? nestedArgs
      : null;
  const lockedResult = isEncryptedChatUnavailableContent(row.toolResult)
    ? row.toolResult
    : null;

  const toolCall =
    lockedArgs && !isLogContentNotStored(lockedArgs)
      ? null
      : (row.toolCall as { name?: string; arguments?: unknown } | null);
  const result = lockedResult
    ? null
    : (row.toolResult as {
        isError?: boolean;
        error?: string;
        content?: unknown;
      } | null);
  const notStoredResult = isLogContentNotStored(row.toolResult)
    ? row.toolResult
    : null;
  const outcome = result ?? notStoredResult;

  // Success / error / cancelled — a cancelled call (the user stopped the run
  // or the background task) is neither a success nor a failure.
  const status: McpToolCallOutcomeStatus =
    lockedResult && !canShowMcpToolCallStatus(method, lockedResult)
      ? "unknown"
      : method === "tools/call" && outcome
        ? resolveMcpToolCallStatus(outcome)
        : "success";

  const fullName = typeof toolCall?.name === "string" ? toolCall.name : null;
  return {
    method,
    toolName: fullName
      ? parseFullToolName(fullName).toolName || fullName
      : null,
    args: lockedArgs ? undefined : toolCall?.arguments,
    lockedArgs,
    result,
    lockedResult,
    status,
    executedAs: extractMcpExecutedAs(outcome),
  };
}

export const MCP_TOOL_CALL_STATUS_LABELS: Record<
  McpToolCallOutcomeStatus,
  string
> = {
  success: "Success",
  error: "Error",
  cancelled: "Cancelled",
  unknown: "Outcome unavailable",
};
