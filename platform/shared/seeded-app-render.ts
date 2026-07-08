/**
 * Platform-reserved `_meta` key marking a tool result the platform itself
 * authored when seeding an app-open conversation (no upstream tool ran, so the
 * result carries no external data). The trusted-data guardrail keys off it to
 * keep opening an app from flipping the conversation's context to sensitive.
 * Like `archestraError`, it is stripped from every live upstream tool result
 * (see mcp-client's reserved-meta stripping), so an upstream server cannot
 * forge it to slip untrusted output past the injection scan.
 */
export const SEEDED_APP_RENDER_META_KEY = "archestraSeededAppRender";

/**
 * Whether a tool result is a platform-seeded app render (carries the reserved
 * marker in `_meta`). Accepts the shapes trust evaluation actually sees: the
 * stored output object in the chat runtime, or that object JSON-stringified
 * (possibly inside content blocks) in an LLM-proxy request's tool message.
 */
export function isSeededAppRenderToolResult(output: unknown): boolean {
  return hasSeededAppRenderMarker(output, 0);
}

// Unwraps only serialization layers a provider adapter may add around the
// seeded output object — a JSON-stringified copy, a content-block array, or a
// `{ type: "text", text }` block — and accepts the marker solely at the
// unwrapped object's top-level `_meta`. Deliberately does NOT descend into a
// result object's own `content`/`text` payload fields: that text is
// upstream-authored and never passes through the reserved-meta stripping, so
// treating a marker found there as platform-authored would let a hostile
// server forge it.
function hasSeededAppRenderMarker(value: unknown, depth: number): boolean {
  if (depth > 3 || value == null) {
    return false;
  }

  if (typeof value === "string") {
    // Cheap pre-check: the marker key must appear somewhere in the string
    // before we pay for a JSON.parse of an arbitrary tool result.
    if (!value.includes(SEEDED_APP_RENDER_META_KEY)) {
      return false;
    }
    try {
      return hasSeededAppRenderMarker(JSON.parse(value), depth + 1);
    } catch {
      return false;
    }
  }

  if (typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasSeededAppRenderMarker(item, depth + 1));
  }

  const record = value as { _meta?: unknown; type?: unknown; text?: unknown };
  if (record.type === "text" && typeof record.text === "string") {
    return hasSeededAppRenderMarker(record.text, depth + 1);
  }

  return (
    typeof record._meta === "object" &&
    record._meta !== null &&
    (record._meta as Record<string, unknown>)[SEEDED_APP_RENDER_META_KEY] ===
      true
  );
}
