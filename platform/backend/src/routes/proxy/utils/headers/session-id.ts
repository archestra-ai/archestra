import { SESSION_ID_HEADER } from "@shared";
import { getHeaderValue, parseMetaHeader } from "./meta-header";

const OPENWEBUI_CHAT_ID_HEADER = "x-openwebui-chat-id";

/**
 * Session source indicates where the session ID was extracted from.
 * This is stored in the database and displayed in the UI.
 */
export type SessionSource =
  | "claude_code"
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
 * 4. Claude Code metadata.user_id field containing session UUID (source: 'claude_code')
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

  // Priority 4: Claude Code metadata format
  // Format: user_{hash}_account_{account_id}_session_{session_uuid}
  const metadataUserId = body?.metadata?.user_id;
  if (metadataUserId) {
    const match = metadataUserId.match(/session_([a-f0-9-]+)/i);
    if (match) {
      return { sessionId: match[1], sessionSource: "claude_code" };
    }
  }

  // Priority 5: OpenAI user field (some clients use this for session tracking)
  const user = body?.user;
  if (user && typeof user === "string" && user.trim().length > 0) {
    return { sessionId: user.trim(), sessionSource: "openai_user" };
  }

  return { sessionId: null, sessionSource: null };
}
