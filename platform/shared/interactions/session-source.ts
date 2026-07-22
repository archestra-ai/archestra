/**
 * `interactions.session_source` records the *provenance of the session id* — it
 * does NOT identify the client app (that is `interactions.external_agent_id`;
 * see ./client). All Claude/Anthropic `metadata.user_id` shapes record
 * {@link CLAUDE_METADATA_SESSION_SOURCE}; legacy rows may still carry
 * {@link LEGACY_CLAUDE_CODE_SESSION_SOURCE} / {@link LEGACY_CLAUDE_DESKTOP_SESSION_SOURCE}.
 */
export const CLAUDE_METADATA_SESSION_SOURCE = "claude_metadata";

/**
 * Pre-unification `session_source` values. No longer written (Anthropic's
 * unified metadata format can't distinguish the two), but still read on old
 * rows — hence retained for {@link isClaudeSessionSource} and the legacy
 * request-type heuristic.
 */
export const LEGACY_CLAUDE_CODE_SESSION_SOURCE = "claude_code";
export const LEGACY_CLAUDE_DESKTOP_SESSION_SOURCE = "claude_desktop";

const CLAUDE_SESSION_SOURCES = new Set<string>([
  CLAUDE_METADATA_SESSION_SOURCE,
  LEGACY_CLAUDE_CODE_SESSION_SOURCE,
  LEGACY_CLAUDE_DESKTOP_SESSION_SOURCE,
]);

/**
 * Whether a stored `session_source` value denotes a Claude/Anthropic session.
 * Accepts the current `claude_metadata` and the legacy `claude_code` /
 * `claude_desktop` values so read paths behave identically across old and new
 * rows (request-type heuristics, delta-encoding eligibility).
 */
export function isClaudeSessionSource(
  sessionSource: string | null | undefined,
): boolean {
  return sessionSource != null && CLAUDE_SESSION_SOURCES.has(sessionSource);
}
