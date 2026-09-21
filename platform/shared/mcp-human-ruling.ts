/**
 * Platform-reserved `_meta` key for human review rulings on held tool calls.
 * The platform attaches this metadata to remedy results so Chat can display
 * whether the user approved or denied the call.
 * This metadata never reaches the model and is stripped from upstream tool results.
 */
export const MCP_HUMAN_RULING_META_KEY = "archestraHumanRuling";

export type McpHumanRuling = "approve" | "deny";

/**
 * Reads the human ruling from a tool result's `_meta`.
 * Returns null if missing or if the value is not a valid ruling.
 */
export function extractMcpHumanRuling(result: unknown): McpHumanRuling | null {
  if (result == null || typeof result !== "object") {
    return null;
  }

  const candidate = (
    result as { _meta?: { [MCP_HUMAN_RULING_META_KEY]?: unknown } }
  )._meta?.[MCP_HUMAN_RULING_META_KEY];

  return candidate === "approve" || candidate === "deny" ? candidate : null;
}
