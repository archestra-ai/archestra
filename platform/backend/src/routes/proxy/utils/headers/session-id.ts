import {
  CLAUDE_CODE_HEADER_SESSION_SOURCE,
  CLAUDE_METADATA_SESSION_SOURCE,
  isCodexClientAgentId,
  isOpenCodeClientAgentId,
  SESSION_ID_HEADER,
} from "@archestra/shared";
import { getHeaderValue, parseMetaHeader } from "./meta-header";

const OPENWEBUI_CHAT_ID_HEADER = "x-openwebui-chat-id";
/** OpenCode's session headers, most specific first; `session-id` is Responses-only. */
const OPENCODE_SESSION_ID_HEADERS = [
  "x-session-id",
  "x-session-affinity",
  "x-opencode-session",
  "session-id",
] as const;

/**
 * The Codex CLI stamps its session id on every request in a `session-id` header
 * (codex-rs `build_session_headers`) and in the `client_metadata` body object.
 * Both are read only when the request's resolved client attribution is a Codex
 * client id — the header name is too generic to trust on its own.
 */
const CODEX_SESSION_ID_HEADER = "session-id";

/**
 * Session source indicates where the session ID was extracted from. This is
 * stored in the database and is purely about *provenance of the session id* —
 * it does NOT identify the client app. Client-app attribution lives in the
 * `external_agent_id` column (see {@link ./client-app}).
 *
 * `claude_metadata` covers every Claude/Anthropic `metadata.user_id` shape
 * (the unified `{…,"session_id":…}` JSON and the legacy
 * `user_…_session_<uuid>` string), which Anthropic no longer differentiates by
 * client. Legacy rows may still carry `claude_code` / `claude_desktop`; read
 * paths treat those as equivalent via `isClaudeSessionSource`
 * (`@archestra/shared`).
 */
export type SessionSource =
  | typeof CLAUDE_METADATA_SESSION_SOURCE
  | "header"
  | "appa_header"
  | "meta_header"
  | "openwebui_chat"
  | "codex_session"
  | "opencode_session"
  | typeof CLAUDE_CODE_HEADER_SESSION_SOURCE
  | "openai_user"
  | null;

export interface SessionInfo {
  sessionId: string | null;
  sessionSource: SessionSource;
}

/**
 * Extract session information from request headers and body.
 * Session IDs allow grouping related LLM requests together in the logs UI.
 *
 * Priority order:
 * 1. Explicit X-Archestra-Session-Id header (source: 'header')
 * 2. X-Archestra-Meta third segment (source: 'meta_header')
 * 3. Open WebUI X-OpenWebUI-Chat-Id header (source: 'openwebui_chat')
 * 4. Codex session id — only when `externalAgentId` is a Codex client id:
 *    `client_metadata.thread_id` body field first, then `session_id`, then
 *    the `session-id` request header (source: 'codex_session')
 * 5. OpenCode session id — only when `externalAgentId` was configured by the
 *    caller or resolved from OpenCode's native User-Agent/originator:
 *    `x-session-id`, `x-session-affinity`, `x-opencode-session`, then the
 *    `session-id` header its Responses requests carry (source:
 *    'opencode_session'). A delegated child keeps its own native session id;
 *    its parent signal classifies the row instead of renaming it.
 * 6. Claude Code `x-claude-code-session-id` (source: 'claude_code_header').
 *    `/branch` or `--fork-session` creates a new ID here, ensuring forks
 *    record as separate sessions in logs.
 * 7. Claude/Anthropic metadata.user_id (source: 'claude_metadata')
 * 8. OpenAI user field (source: 'openai_user')
 *
 * @param headers - The request headers object
 * @param body - The request body (may contain metadata.user_id, user, or
 *   client_metadata)
 * @param externalAgentId - The request's resolved client attribution: the
 *   caller-supplied X-Archestra-Agent-Id header or, when absent, client-app
 *   auto-discovery (see {@link ./client-app}). Gates client-specific session
 *   signals so another request never gets OpenCode or Codex provenance, and
 *   keeps client identification in one place.
 * @returns SessionInfo with sessionId and sessionSource
 */
export function extractSessionInfo({
  headers,
  body,
  externalAgentId,
}: {
  headers: Record<string, string | string[] | undefined>;
  body:
    | {
        metadata?: { user_id?: string | null };
        user?: string | null;
        client_metadata?: unknown;
      }
    | undefined;
  externalAgentId: string | undefined;
}): SessionInfo {
  // Priority 1: Explicit header
  const headerSessionId = getHeaderValue(headers, SESSION_ID_HEADER);
  if (headerSessionId) {
    return { sessionId: headerSessionId, sessionSource: "header" };
  }

  // Priority 2: Meta header fallback
  const meta = parseMetaHeader(headers);
  if (meta.sessionId) {
    return { sessionId: meta.sessionId, sessionSource: "meta_header" };
  }

  // Priority 3: Open WebUI chat ID header
  // Sent when ENABLE_FORWARD_USER_INFO_HEADERS=true in Open WebUI
  const openwebuiChatId = getHeaderValue(headers, OPENWEBUI_CHAT_ID_HEADER);
  if (openwebuiChatId) {
    return { sessionId: openwebuiChatId, sessionSource: "openwebui_chat" };
  }

  // Priority 4: Codex session id, gated on the resolved client attribution —
  // the `session-id` header name is generic, so it is never read as a Codex
  // session on its own.
  if (isCodexClientAgentId(externalAgentId)) {
    const metadataSessionId =
      codexClientMetadataValue(body?.client_metadata, "thread_id") ??
      codexClientMetadataValue(body?.client_metadata, "session_id");
    if (metadataSessionId) {
      return { sessionId: metadataSessionId, sessionSource: "codex_session" };
    }
    const codexHeaderSessionId = getHeaderValue(
      headers,
      CODEX_SESSION_ID_HEADER,
    );
    if (codexHeaderSessionId?.trim()) {
      return {
        sessionId: codexHeaderSessionId.trim(),
        sessionSource: "codex_session",
      };
    }
  }

  // Priority 5: OpenCode's session id, gated on the resolved client
  // attribution for the same reason as Codex: these header names are generic.
  if (isOpenCodeClientAgentId(externalAgentId)) {
    for (const header of OPENCODE_SESSION_ID_HEADERS) {
      const openCodeSessionId = getHeaderValue(headers, header)?.trim();
      if (openCodeSessionId) {
        return {
          sessionId: openCodeSessionId,
          sessionSource: "opencode_session",
        };
      }
    }
  }

  // Priority 6: Claude Code's own session header. `/branch` or
  // `--fork-session` mints a new value here while `metadata.user_id.session_id`
  // stays on the parent conversation.
  const claudeCodeSessionId = getHeaderValue(
    headers,
    "x-claude-code-session-id",
  );
  if (claudeCodeSessionId) {
    return {
      sessionId: claudeCodeSessionId,
      sessionSource: CLAUDE_CODE_HEADER_SESSION_SOURCE,
    };
  }

  // Priority 7: Claude/Anthropic metadata.user_id (any known format)
  const claudeSessionId = parseClaudeMetadataSessionId(body?.metadata?.user_id);
  if (claudeSessionId) {
    return {
      sessionId: claudeSessionId,
      sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
    };
  }

  // Priority 8: OpenAI user field (some clients use this for session tracking)
  const user = body?.user;
  if (user && typeof user === "string" && user.trim().length > 0) {
    return { sessionId: user.trim(), sessionSource: "openai_user" };
  }

  return { sessionId: null, sessionSource: null };
}

function codexClientMetadataValue(
  clientMetadata: unknown,
  key: "session_id" | "thread_id",
): string | null {
  if (!clientMetadata || typeof clientMetadata !== "object") {
    return null;
  }
  const value = (clientMetadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Extract a session id from a Claude/Anthropic `metadata.user_id` value,
 * trying every known format (newest first):
 *
 * - Unified JSON string carrying the session id, e.g.
 *   `{"device_id":"…","account_uuid":"…","session_id":"<uuid>"}` — sent by all
 *   current Claude clients (Claude Code, Cowork/Desktop, VSCode).
 * - Legacy plain string `user_<hash>_account_<id>_session_<uuid>` — older
 *   Claude Code versions still in the wild.
 *
 * Returns the trimmed session id, or `null` when the value is absent or matches
 * no known Claude format. Kept format-exhaustive for backward compatibility.
 */
export function parseClaudeMetadataSessionId(
  userId: string | null | undefined,
): string | null {
  if (!userId) {
    return null;
  }

  // Unified JSON format.
  if (userId.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(userId) as { session_id?: unknown };
      if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
        return parsed.session_id.trim();
      }
    } catch {
      // Not JSON — fall through to the legacy string format.
    }
  }

  // Legacy `..._session_<uuid>` string format.
  const match = userId.match(/session_([a-f0-9-]+)/i);
  if (match) {
    return match[1];
  }

  return null;
}

/**
 * Whether a `metadata.user_id` value matches any known Claude/Anthropic format.
 * Used by client-app auto-discovery to attribute a request to the generic
 * Claude client id.
 */
export function isClaudeMetadataUserId(
  userId: string | null | undefined,
): boolean {
  return parseClaudeMetadataSessionId(userId) !== null;
}
