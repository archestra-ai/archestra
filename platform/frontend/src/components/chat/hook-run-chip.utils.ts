/**
 * Pretty-print a hook payload's JSON string for the debug chip. Returns the
 * input unchanged when it isn't valid JSON — a capped payload has a
 * `…[truncated N chars]` marker appended and no longer parses, and we'd still
 * rather show it than nothing.
 */
export function prettyPrintJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export interface SplitHookPayload {
  /** `tool_input` from the payload (Pre/PostToolUse), if present. */
  toolInput?: unknown;
  /** `tool_response` from the payload (PostToolUse), if present. */
  toolResponse?: unknown;
  /** Every other payload field (scalar metadata like session_id, cwd, …). */
  rest: Record<string, unknown>;
}

/**
 * Split a hook payload JSON string into render sections: the tool input and
 * tool response get their own blocks (so multi-line strings show real line
 * breaks instead of `\n` escapes), everything else becomes a key-value list.
 * Returns null when the payload isn't a JSON object — e.g. capped payloads
 * carry a `…[truncated N chars]` marker and no longer parse — so the caller
 * falls back to showing the raw string.
 */
export function splitHookPayload(payloadJson: string): SplitHookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const {
    tool_input: toolInput,
    tool_response: toolResponse,
    ...rest
  } = parsed as Record<string, unknown>;
  return {
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolResponse !== undefined ? { toolResponse } : {}),
    rest,
  };
}
