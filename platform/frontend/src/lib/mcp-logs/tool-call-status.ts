import {
  extractMcpToolError,
  isLockedChatUnavailableContent,
  isLogContentNotStored,
} from "@archestra/shared";

/**
 * Status of a logged MCP tool call, as the log surfaces render it.
 *
 * Cancelled is detected through the shared `extractMcpToolError` (the same
 * schema-validated extractor every other structured-error consumer uses) —
 * deliberately checked before `isError`, because a user-initiated stop is
 * neither a success nor a failure and must not be painted as either.
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
  if (!isLockedChatUnavailableContent(result)) {
    return true;
  }
  return (
    isLogContentNotStored(result) &&
    (method !== "tools/call" || result.isError !== undefined)
  );
}

type McpToolCallStatus = "success" | "error" | "cancelled";
