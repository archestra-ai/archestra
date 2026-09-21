/**
 * Platform-reserved `_meta` key recording the ruling a person gave on a call
 * the guardrails policy held for their review. The platform stamps it on the
 * remedy's result so the chat card can say whether the viewer approved or
 * denied the call. Like every `_meta` key it never reaches the model, and like
 * `archestraError` it is stripped from every upstream tool result, so a server
 * cannot make its own card claim a ruling nobody gave.
 */
export const MCP_HUMAN_RULING_META_KEY = "archestraHumanRuling";

export type McpHumanRuling = "approve" | "deny";

/**
 * Read the human ruling off a tool result's `_meta`. Null for every result
 * that carries none, and for any value other than the two rulings.
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
