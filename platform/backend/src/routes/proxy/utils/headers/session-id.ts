import { SESSION_ID_HEADER } from "@archestra/shared";
import { getHeaderValue, parseMetaHeader } from "./meta-header";

const OPENWEBUI_CHAT_ID_HEADER = "x-openwebui-chat-id";

/**
 * Session source indicates where the session ID was extracted from.
 * This is stored in the database and displayed in the UI.
 */
export type SessionSource =
  | "claude_code"
  | "claude_desktop"
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
 * 4. Claude Desktop metadata.user_id JSON string with session_id (source: 'claude_desktop')
 * 5. Claude Code metadata.user_id field containing session UUID (source: 'claude_code')
 * 6. OpenAI user field (source: 'openai_user')
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

  // Priority 4: Claude Desktop (cowork) metadata format
  // Format: user_id is a JSON string like
  //   {"device_id":"...","account_uuid":"...","session_id":"<uuid>"}
  const metadataUserId = body?.metadata?.user_id;
  if (metadataUserId) {
    const desktopSessionId = parseClaudeDesktopSessionId(metadataUserId);
    if (desktopSessionId) {
      return { sessionId: desktopSessionId, sessionSource: "claude_desktop" };
    }
  }

  // Priority 5: Claude Code metadata format
  // Format: user_{hash}_account_{account_id}_session_{session_uuid}
  if (metadataUserId) {
    const match = metadataUserId.match(/session_([a-f0-9-]+)/i);
    if (match) {
      return { sessionId: match[1], sessionSource: "claude_code" };
    }
  }

  // Priority 6: OpenAI user field (some clients use this for session tracking)
  const user = body?.user;
  if (user && typeof user === "string" && user.trim().length > 0) {
    return { sessionId: user.trim(), sessionSource: "openai_user" };
  }

  return { sessionId: null, sessionSource: null };
}

/**
 * Claude Desktop (cowork) sends metadata.user_id as a JSON string carrying the
 * session id, e.g. {"device_id":"...","account_uuid":"...","session_id":"<uuid>"}.
 * Returns the trimmed session_id when the value parses to such an object, or null
 * otherwise (Claude Code's plain `user_..._session_<uuid>` string is not JSON and
 * falls through to the Claude Code branch).
 */
function parseClaudeDesktopSessionId(userId: string): string | null {
  if (!userId.trimStart().startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown };
    if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
      return parsed.session_id.trim();
    }
  } catch {
    // Not JSON — fall through to other session sources.
  }
  return null;
}
