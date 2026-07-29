/**
 * Status of a logged MCP tool call, as the log surfaces render it.
 *
 * Cancelled is detected from the structured `archestraError` marker the
 * backend persists when a call is aborted mid-flight (a stopped run or a
 * cancelled background task) — deliberately checked before `isError`, because
 * a user-initiated stop is neither a success nor a failure and must not be
 * painted as either.
 */
export type McpToolCallStatus = "success" | "error" | "cancelled";

export function resolveMcpToolCallStatus(result: unknown): McpToolCallStatus {
  if (typeof result !== "object" || result === null) {
    return "success";
  }
  const meta = (result as { _meta?: unknown })._meta;
  if (typeof meta === "object" && meta !== null) {
    const archestraError = (meta as { archestraError?: unknown })
      .archestraError;
    if (
      typeof archestraError === "object" &&
      archestraError !== null &&
      (archestraError as { type?: unknown }).type === "cancelled"
    ) {
      return "cancelled";
    }
  }
  return (result as { isError?: unknown }).isError ? "error" : "success";
}
