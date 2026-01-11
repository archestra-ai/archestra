import { SESSION_ID_HEADER } from "@shared";

/**
 * Session source indicates where the session ID was extracted from.
 * This is stored in the database and displayed in the UI.
 */
export type SessionSource = "claude_code" | "header" | "openai_user" | null;

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
 * 2. Claude Code metadata.user_id field containing session UUID (source: 'claude_code')
 * 3. OpenAI user field (source: 'openai_user')
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

  // Priority 2: Claude Code metadata format
  // Format: user_{hash}_account_{account_id}_session_{session_uuid}
  const metadataUserId = body?.metadata?.user_id;
  if (metadataUserId) {
    const match = metadataUserId.match(/session_([a-f0-9-]+)/i);
    if (match) {
      return { sessionId: match[1], sessionSource: "claude_code" };
    }
  }

  // Priority 3: OpenAI user field (some clients use this for session tracking)
  const user = body?.user;
  if (user && typeof user === "string" && user.trim().length > 0) {
    return { sessionId: user.trim(), sessionSource: "openai_user" };
  }

  return { sessionId: null, sessionSource: null };
}

/**
 * Helper to get a header value from the headers object.
 * Handles both string and array values.
 */
function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
): string | undefined {
  // HTTP headers are case-insensitive, so we check lowercase
  const headerKey = headerName.toLowerCase();
  const headerValue = headers[headerKey];

  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return headerValue.trim();
  }

  // Handle case where header might be an array
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    const firstValue = headerValue[0];
    if (typeof firstValue === "string" && firstValue.trim().length > 0) {
      return firstValue.trim();
    }
  }

  return undefined;
}
