import { z } from "zod";

/**
 * Client/session sources that can be filtered in the LLM logs list.
 *
 * These are values of the `interactions.session_source` column (where the
 * session ID was extracted from). Unlike {@link InteractionSource} (the
 * `source` column), only the Claude clients are exposed as user-facing filter
 * options today.
 */
const SESSION_CLIENT_SOURCES = ["claude_code", "claude_desktop"] as const;

export const SessionClientSourceSchema = z.enum(SESSION_CLIENT_SOURCES);

export type SessionClientSource = z.infer<typeof SessionClientSourceSchema>;

/**
 * Human-readable labels for the client/session sources. Shared by the logs
 * list "Client" filter and the session/list badges so the label lives in one
 * place.
 */
export const SESSION_CLIENT_SOURCE_DISPLAY: Record<
  SessionClientSource,
  { label: string }
> = {
  claude_code: { label: "Claude Code" },
  claude_desktop: { label: "Claude Desktop" },
};

/**
 * Returns the human-readable client label for a `session_source` value, or
 * `null` for sources that are not surfaced as a client (header, openai_user,
 * etc., or null).
 */
export function getSessionClientLabel(
  sessionSource: string | null | undefined,
): string | null {
  if (sessionSource && sessionSource in SESSION_CLIENT_SOURCE_DISPLAY) {
    return SESSION_CLIENT_SOURCE_DISPLAY[sessionSource as SessionClientSource]
      .label;
  }
  return null;
}
