import { CLAUDE_CLIENT_ID } from "@archestra/shared";
import { isClaudeMetadataUserId } from "./session-id";

/**
 * Client-app auto-discovery.
 *
 * When the caller does NOT supply an explicit `X-Archestra-Agent-Id` header,
 * we best-effort attribute the request to a known client app and persist that
 * id in `interactions.external_agent_id`. Identification is per-app; recording
 * is uniform. This phase recognizes Claude clients only, all recorded as the
 * generic {@link CLAUDE_CLIENT_ID} — we can only distinguish Claude Code from
 * Claude Desktop when the caller sets `X-Archestra-Agent-Id` itself (the setup
 * scripts do this), never from the request alone.
 *
 * Two Claude signals, in order:
 * 1. The Anthropic `x-anthropic-billing-header` hint embedded in a `system`
 *    text block, e.g. `cc_version=2.1.195.1ff; cc_entrypoint=claude-vscode;`.
 *    Any non-empty `cc_entrypoint` (known or unknown) ⇒ Claude.
 * 2. A Claude/Anthropic `metadata.user_id` format (see
 *    {@link isClaudeMetadataUserId}).
 */
export function detectClaudeClientId(
  body:
    | {
        system?: unknown;
        metadata?: { user_id?: string | null } | null;
      }
    | undefined,
): typeof CLAUDE_CLIENT_ID | undefined {
  if (!body) {
    return undefined;
  }
  if (hasAnthropicBillingEntrypoint(body.system)) {
    return CLAUDE_CLIENT_ID;
  }
  if (isClaudeMetadataUserId(body.metadata?.user_id)) {
    return CLAUDE_CLIENT_ID;
  }
  return undefined;
}

// Anthropic `cc_entrypoint` values for in-scope Claude clients are e.g.
// `claude-code`, `claude-vscode`, `cowork`, `claude-desktop`. Detection does
// NOT gate on this list: any non-empty `cc_entrypoint` (known or unknown)
// attributes to the generic Claude id (per spec). The capture below is a seam for a
// future per-app split.
const CC_ENTRYPOINT_RE = /cc_entrypoint=([^;\s]+)/i;

/**
 * Whether any `system` text block carries an `x-anthropic-billing-header` line
 * with a non-empty `cc_entrypoint`. `system` is either a string or an array of
 * content blocks (`{ type, text }`); other shapes are ignored.
 */
function hasAnthropicBillingEntrypoint(system: unknown): boolean {
  const text = flattenSystemText(system);
  if (!text.toLowerCase().includes("x-anthropic-billing-header")) {
    return false;
  }
  const match = text.match(CC_ENTRYPOINT_RE);
  return match !== null && match[1].trim().length > 0;
}

function flattenSystemText(system: unknown): string {
  if (typeof system === "string") {
    return system;
  }
  if (Array.isArray(system)) {
    return system
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text?: unknown }).text ?? "")
          : "",
      )
      .join("\n");
  }
  return "";
}
