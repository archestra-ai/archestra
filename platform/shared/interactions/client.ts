import { z } from "zod";

/**
 * Client-app attribution for an interaction lives in
 * `interactions.external_agent_id`. It is set from the caller's
 * `X-Archestra-Agent-Id` header (e.g. the connect-page setup scripts send
 * {@link CLAUDE_CODE_CLIENT_ID} / {@link CLAUDE_DESKTOP_CLIENT_ID}) or, when
 * absent, from auto-discovery of a Claude client (recorded as the generic
 * {@link CLAUDE_CLIENT_ID}). Every Claude-family id renders as a single
 * {@link CLAUDE_CLIENT_LABEL} in the UI.
 */

/** Human-readable label for every Claude client id in the UI. */
export const CLAUDE_CLIENT_LABEL = "Claude";

/**
 * `external_agent_id` values for Claude clients:
 * - {@link CLAUDE_CLIENT_ID} — generic; recorded by auto-discovery when no
 *   `X-Archestra-Agent-Id` header is present, and the backfill target for legacy
 *   rows that only carried a Claude `session_source`.
 * - {@link CLAUDE_CODE_CLIENT_ID} / {@link CLAUDE_DESKTOP_CLIENT_ID} — set
 *   explicitly by the connect-page setup scripts so Claude Code and Claude
 *   Desktop can be told apart.
 */
export const CLAUDE_CLIENT_ID = "anthropic_claude";
export const CLAUDE_CODE_CLIENT_ID = "anthropic_claude_code";
export const CLAUDE_DESKTOP_CLIENT_ID = "anthropic_claude_desktop";

export const CLAUDE_CLIENT_AGENT_IDS = [
  CLAUDE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
] as const;

const CLAUDE_CLIENT_AGENT_ID_SET = new Set<string>(CLAUDE_CLIENT_AGENT_IDS);

/** Whether an `external_agent_id` value denotes a Claude client app. */
export function isClaudeClientAgentId(
  externalAgentId: string | null | undefined,
): boolean {
  if (!externalAgentId) {
    return false;
  }
  return CLAUDE_CLIENT_AGENT_ID_SET.has(externalAgentId.trim().toLowerCase());
}

/**
 * Value used by the `/llm/logs` "Client" filter (URL/query key). Distinct from
 * the stored ids above: the backend expands it to {@link CLAUDE_CLIENT_AGENT_IDS}.
 * Only Claude is surfaced today.
 */
export const CLAUDE_CLIENT_FILTER = "claude";

export const ClientFilterSchema = z.enum([CLAUDE_CLIENT_FILTER]);

export type ClientFilter = z.infer<typeof ClientFilterSchema>;

/** Options for the logs "Client" filter dropdown. */
export const CLIENT_FILTER_OPTIONS: ReadonlyArray<{
  value: ClientFilter;
  label: string;
}> = [{ value: CLAUDE_CLIENT_FILTER, label: CLAUDE_CLIENT_LABEL }];
