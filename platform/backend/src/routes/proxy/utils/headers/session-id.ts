import {
  CLAUDE_METADATA_SESSION_SOURCE,
  SESSION_ID_HEADER,
} from "@archestra/shared";
import { getHeaderValue, parseMetaHeader } from "./meta-header";

const OPENWEBUI_CHAT_ID_HEADER = "x-openwebui-chat-id";

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
  | "meta_header"
  | "openwebui_chat"
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
 * 4. Claude/Anthropic metadata.user_id (source: 'claude_metadata')
 * 5. OpenAI user field (source: 'openai_user')
 *
 * @param headers - The request headers object
 * @param body - The request body (may contain metadata.user_id or user field)
 * @returns SessionInfo with sessionId and sessionSource
 */
export function extractSessionInfo(
  headers: Record<string, string | string[] | undefined>,
  body:
    | { metadata?: { user_id?: string | null }; user?: string | null }
    | undefined,
): SessionInfo {
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

  // Priority 4: Claude/Anthropic metadata.user_id (any known format)
  const claudeSessionId = parseClaudeMetadataSessionId(body?.metadata?.user_id);
  if (claudeSessionId) {
    return {
      sessionId: claudeSessionId,
      sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
    };
  }

  // Priority 5: OpenAI user field (some clients use this for session tracking)
  const user = body?.user;
  if (user && typeof user === "string" && user.trim().length > 0) {
    return { sessionId: user.trim(), sessionSource: "openai_user" };
  }

  return { sessionId: null, sessionSource: null };
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
function parseClaudeMetadataSessionId(
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
