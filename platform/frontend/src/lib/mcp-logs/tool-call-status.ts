import {
  extractMcpToolError,
  isEncryptedChatUnavailableContent,
  isLogContentNotStored,
} from "@archestra/shared";

/**
 * Status of a logged MCP tool call, as the log surfaces render it.
 *
 * Cancelled and blocked are detected through the shared `extractMcpToolError`
 * (the same schema-validated extractor every other structured-error consumer
 * uses) — deliberately checked before `isError`. A user-initiated stop is
 * neither a success nor a failure, and a call the platform refused never ran,
 * so neither is painted as the tool failing.
 *
 * A row logged under the Metadata only setting has no result to inspect; its
 * marker carries the same two facts instead.
 */
export function resolveMcpToolCallStatus(result: unknown): McpToolCallStatus {
  const errorType = isLogContentNotStored(result)
    ? result.errorType
    : extractMcpToolError(result)?.type;
  if (errorType === "cancelled") {
    return "cancelled";
  }
  if (isMcpToolCallRefusal(result)) {
    return "blocked";
  }
  const isError =
    typeof result === "object" &&
    result !== null &&
    Boolean((result as { isError?: unknown }).isError);
  return isError ? "error" : "success";
}

/**
 * Whether a logged result backs a status badge, or the row has to say its
 * content is unavailable instead.
 *
 * A locked chat's result is encrypted or missing, and the status lives inside
 * it, so painting a badge would assert an outcome the row does not record. A
 * Metadata only marker is different: other methods never read their status
 * from the result, and a `tools/call` marker keeps it whenever it carries
 * `isError`.
 */
export function canShowMcpToolCallStatus(
  method: string,
  result: unknown,
): boolean {
  if (!isEncryptedChatUnavailableContent(result)) {
    return true;
  }
  return (
    isLogContentNotStored(result) &&
    (method !== "tools/call" || result.isError !== undefined)
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Whether a result is the platform refusing to run the call: the tool is not
 * assigned, not enabled for the conversation, or excluded. Other `tool_state`
 * errors (an unknown knowledge base, a missing skill file) come from a tool
 * that did run, so they stay errors. A Metadata only marker keeps only the
 * error type, not the code, so it cannot tell the two apart.
 */
function isMcpToolCallRefusal(result: unknown): boolean {
  const error = extractMcpToolError(result);
  return error?.type === "tool_state" && REFUSAL_CODES.has(error.code);
}

type McpToolCallStatus = "success" | "error" | "cancelled" | "blocked";

/** The `tool_state` codes the gateway and the tool runner refuse a call with. */
const REFUSAL_CODES = new Set([
  "tool_not_enabled",
  "tool_not_directly_callable",
  "tool_not_assigned",
  "tool_disabled",
  "unknown_tool",
]);
