import {
  CLAUDE_CLIENT_ID,
  CODEX_CLIENT_ID,
  isCodexOriginator,
} from "@archestra/shared";
import { getHeaderValue } from "./meta-header";
import { isClaudeMetadataUserId } from "./session-id";

/**
 * Client-app auto-discovery.
 *
 * When the caller does NOT supply an explicit `X-Archestra-Agent-Id` header,
 * we best-effort attribute the request to a known client app and persist that
 * id in `interactions.external_agent_id`. Identification is per-app; recording
 * is uniform. Two client families are recognized, each recorded as its generic
 * id: Claude clients ({@link detectClaudeClientId} → {@link CLAUDE_CLIENT_ID})
 * and Codex clients ({@link detectCodexClientId} → {@link CODEX_CLIENT_ID}). The
 * finer split (Claude Code vs Desktop) is only knowable when the caller sets
 * `X-Archestra-Agent-Id` itself (the setup scripts do this), never from the
 * request alone.
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

/**
 * Codex client auto-discovery — the Codex counterpart to
 * {@link detectClaudeClientId}. Codex has no request-body fingerprint we rely
 * on; instead it stamps its identity on the `originator` request header
 * (`codex_cli_rs` by default) and repeats it as the User-Agent's leading token
 * on every request, exactly the way the Anthropic billing header identifies
 * Claude. When the caller sets no explicit `X-Archestra-Agent-Id`, a
 * first-party Codex originator (see {@link isCodexOriginator}) — or a matching
 * User-Agent, in case a middlebox drops the originator header — attributes the
 * request to {@link CODEX_CLIENT_ID}.
 */
export function detectCodexClientId(
  headers: Record<string, string | string[] | undefined>,
): typeof CODEX_CLIENT_ID | undefined {
  if (isCodexOriginator(getHeaderValue(headers, "originator"))) {
    return CODEX_CLIENT_ID;
  }
  // The User-Agent leads with the same originator value, e.g.
  // `codex_cli_rs/0.20.0 (Linux 6.6; x86_64) …` — the token before the slash.
  const userAgent = getHeaderValue(headers, "user-agent");
  if (userAgent && isCodexOriginator(userAgent.split("/", 1)[0])) {
    return CODEX_CLIENT_ID;
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
