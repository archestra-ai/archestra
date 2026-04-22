/**
 * Sentinel element used inside a `limits.model` JSONB array to indicate that the
 * limit covers spend across every model, not a specific set.
 */
export const ALL_MODELS_SENTINEL = "*";

export function validateLimitShape(data: {
  limitType: "token_cost" | "mcp_server_calls" | "tool_calls";
  model?: string[] | null | undefined;
  mcpServerName?: string | null | undefined;
  toolName?: string | null | undefined;
}): boolean {
  if (data.limitType === "mcp_server_calls") {
    if (!data.mcpServerName) return false;
    if (data.model) return false;
  }
  if (data.limitType === "tool_calls") {
    if (!data.mcpServerName || !data.toolName) return false;
    if (data.model) return false;
  }
  if (data.limitType === "token_cost") {
    if (!data.model || !Array.isArray(data.model) || data.model.length === 0) {
      return false;
    }
    if (data.mcpServerName || data.toolName) return false;
    if (data.model.includes(ALL_MODELS_SENTINEL) && data.model.length !== 1) {
      return false;
    }
  }
  return true;
}
