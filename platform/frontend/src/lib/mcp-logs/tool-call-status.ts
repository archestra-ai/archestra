import { extractMcpToolError, isLogContentNotStored } from "@archestra/shared";

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

type McpToolCallStatus = "success" | "error" | "cancelled";
