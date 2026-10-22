import {
  type EncryptedChatRedactedContent,
  type EncryptedChatSealedContent,
  extractMcpExecutedAs,
  extractMcpToolError,
  isEncryptedChatUnavailableContent,
  isLogContentNotStored,
  type McpExecutedAs,
  parseFullToolName,
  TOOL_RUN_TOOL_SHORT_NAME,
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
  | "blocked"
  | "cancelled"
  | "unknown";

/**
 * What one logged MCP call recorded, with the unavailable cases split out
 * before anything reads a field off them.
 *
 * An encrypted chat's call and result are stored encrypted (or, failing
 * closed, not at all), so the columns hold a sentinel rather than the recorded
 * content: the arguments and the outcome are unavailable, and painting the
 * call "Success" would be a claim the row does not support. A sealed column
 * hides the tool's name too; the redaction fallback nests the marker in
 * `arguments` and keeps the name beside it, so that shape still names the
 * tool. A Metadata only row withholds the arguments and the result but keeps
 * the tool's name and the call's outcome in its marker.
 */
export function readMcpToolCall(row: {
  method: string | null;
  toolCall: unknown;
  toolResult: unknown;
}): {
  method: string;
  /** The tool's own name, without its server prefix; null for non-tool methods. */
  toolName: string | null;
  /**
   * For a `run_tool` dispatch, the tool it ran (without its server prefix):
   * every such call is named `run_tool`, which says nothing on its own.
   */
  dispatchedToolName: string | null;
  /** The recorded arguments, or `undefined` when none were recorded. */
  args: unknown;
  lockedArgs: UnavailableContent | null;
  result: { isError?: boolean; error?: string; content?: unknown } | null;
  lockedResult: UnavailableContent | null;
  status: McpToolCallOutcomeStatus;
  /**
   * Why an unsuccessful call ended as it did: the refusal, the error or the
   * cancellation, in words. Null when it succeeded or nothing says.
   */
  outcomeMessage: string | null;
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

  const toolCall = isEncryptedChatUnavailableContent(row.toolCall)
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

  // Success / error / blocked / cancelled — a cancelled call (the user
  // stopped the run or the background task) is neither a success nor a
  // failure, and a blocked one never ran.
  const status: McpToolCallOutcomeStatus =
    lockedResult && !canShowMcpToolCallStatus(method, lockedResult)
      ? "unknown"
      : method === "tools/call" && outcome
        ? resolveMcpToolCallStatus(outcome)
        : "success";

  const fullName = typeof toolCall?.name === "string" ? toolCall.name : null;
  const toolName = fullName
    ? parseFullToolName(fullName).toolName || fullName
    : null;
  return {
    method,
    toolName,
    dispatchedToolName: runToolTargetName(
      toolName,
      lockedArgs ? undefined : toolCall?.arguments,
    ),
    args: lockedArgs ? undefined : toolCall?.arguments,
    lockedArgs,
    result,
    lockedResult,
    status,
    outcomeMessage: result ? readOutcomeMessage(status, result) : null,
    executedAs: extractMcpExecutedAs(outcome),
  };
}

/**
 * The tool a `run_tool` call dispatched to, without its server prefix, or
 * null for any other call (or one whose arguments were not recorded).
 */
export function runToolTargetName(
  toolName: string | null,
  args: unknown,
): string | null {
  if (toolName !== TOOL_RUN_TOOL_SHORT_NAME) return null;
  const target = (args as { tool_name?: unknown } | null | undefined)
    ?.tool_name;
  if (typeof target !== "string" || !target) return null;
  return parseFullToolName(target).toolName || target;
}

/**
 * A tool result's text, when every content block is text: what the tool
 * said, readable as prose instead of a JSON-escaped string. Null for other
 * shapes (images, resources, no content), which only the raw JSON shows.
 */
export function readToolResultText(result: unknown): string | null {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts: string[] = [];
  for (const block of content) {
    const text = readTextBlock(block);
    if (text === null) return null;
    texts.push(text);
  }
  return texts.join("\n\n");
}

/** The tools a `tools/list` result advertised, or null for any other shape. */
export function readListedTools(
  result: unknown,
): { name: string; description: string | null }[] | null {
  const tools = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return null;
  return tools.flatMap((tool) => {
    const { name, description } = (tool ?? {}) as {
      name?: unknown;
      description?: unknown;
    };
    return typeof name === "string"
      ? [
          {
            name,
            description: typeof description === "string" ? description : null,
          },
        ]
      : [];
  });
}

export const MCP_TOOL_CALL_STATUS_LABELS: Record<
  McpToolCallOutcomeStatus,
  string
> = {
  success: "Success",
  error: "Error",
  blocked: "Blocked",
  cancelled: "Cancelled",
  unknown: "Outcome unavailable",
};

// ============================================================================
// Internal helpers
// ============================================================================

function readOutcomeMessage(
  status: McpToolCallOutcomeStatus,
  result: { error?: unknown; content?: unknown },
): string | null {
  if (status === "success" || status === "unknown") return null;
  const structured = extractMcpToolError(result);
  // A refusal or a cancellation says why in its own structured error; an
  // error prefers the platform's message, then the server's own text.
  if (status !== "error" && structured) return structured.message;
  if (typeof result.error === "string" && result.error) return result.error;
  if (structured) return structured.message;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      const text = readTextBlock(block);
      if (text) return text;
    }
  }
  return null;
}

function readTextBlock(block: unknown): string | null {
  const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
  return type === "text" && typeof text === "string" ? text : null;
}
