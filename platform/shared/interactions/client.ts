import { z } from "zod";
import type { SupportedProvider } from "../model-constants";

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

/** Human-readable label for the Codex client id in the UI. */
export const CODEX_CLIENT_LABEL = "Codex";

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

/**
 * `external_agent_id` value for the Codex CLI. Set explicitly by the
 * connect-page setup script via an `X-Archestra-Agent-Id` request header and,
 * when that header is absent, recorded by auto-discovery of a first-party Codex
 * `originator` (see {@link isCodexOriginator}).
 */
export const CODEX_CLIENT_ID = "openai_codex";

/**
 * First-party Codex originators. Codex stamps its client identity on every
 * request in the `originator` header (default `codex_cli_rs`, overridable via
 * `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`) and repeats it as the leading token of
 * the User-Agent — this mirrors codex-rs `is_first_party_originator`. It is the
 * Codex analog of the Anthropic billing header: a purpose-built client-identity
 * signal the proxy uses to auto-attribute a Codex request to
 * {@link CODEX_CLIENT_ID} when no explicit `X-Archestra-Agent-Id` is sent.
 */
const CODEX_FIRST_PARTY_ORIGINATORS = new Set<string>([
  "codex_cli_rs",
  "codex-tui",
  "codex_vscode",
]);

/** Whether an `originator` value denotes a first-party Codex client. */
export function isCodexOriginator(
  originator: string | null | undefined,
): boolean {
  if (!originator) {
    return false;
  }
  const value = originator.trim().toLowerCase();
  return CODEX_FIRST_PARTY_ORIGINATORS.has(value) || value.startsWith("codex ");
}

/**
 * Whether a User-Agent denotes a first-party Codex client. Codex builds its UA
 * with the originator as the leading product token, e.g.
 * `codex_cli_rs/0.20.0 (Linux 6.6; x86_64) …` — checked as a fallback for when
 * a middlebox drops the `originator` header itself.
 */
export function isCodexUserAgent(
  userAgent: string | null | undefined,
): boolean {
  return !!userAgent && isCodexOriginator(userAgent.split("/", 1)[0]);
}

/**
 * Extracts the Codex session id from a Responses-request `client_metadata`
 * object. Codex sends `client_metadata: { session_id, thread_id, turn_id, … }`
 * on every request (session_id is a UUID; per-run, unlike the durable
 * thread_id). Returns the session id when the value matches that shape, null
 * otherwise — a strict shape-match, since `client_metadata` is not a standard
 * OpenAI field but could still be sent by other clients.
 */
export function codexClientMetadataSessionId(
  clientMetadata: unknown,
): string | null {
  if (!clientMetadata || typeof clientMetadata !== "object") {
    return null;
  }
  const sessionId = (clientMetadata as { session_id?: unknown }).session_id;
  if (typeof sessionId === "string" && isCodexSessionId(sessionId.trim())) {
    return sessionId.trim();
  }
  return null;
}

/** Whether a request body value shape-matches Codex `client_metadata`. */
export function isCodexClientMetadata(clientMetadata: unknown): boolean {
  return codexClientMetadataSessionId(clientMetadata) !== null;
}

/**
 * Whether a value has the shape of a Codex session id. Codex session/thread
 * ids are UUIDs (codex-rs generates them via `Uuid`).
 */
export function isCodexSessionId(
  value: string | null | undefined,
): value is string {
  return !!value && UUID_PATTERN.test(value);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * `external_agent_id` values for Codex clients. Only the generic
 * {@link CODEX_CLIENT_ID} exists today (the connect script sets it explicitly
 * and auto-discovery records the same id), but this stays a set to mirror the
 * Claude shape and leave room for a future per-app split.
 */
export const CODEX_CLIENT_AGENT_IDS = [CODEX_CLIENT_ID] as const;

const CODEX_CLIENT_AGENT_ID_SET = new Set<string>(CODEX_CLIENT_AGENT_IDS);

/** Whether an `external_agent_id` value denotes a Codex client app. */
export function isCodexClientAgentId(
  externalAgentId: string | null | undefined,
): boolean {
  if (!externalAgentId) {
    return false;
  }
  return CODEX_CLIENT_AGENT_ID_SET.has(externalAgentId.trim().toLowerCase());
}

/**
 * Values used by the `/llm/logs` "Client" filter (URL/query key). Distinct from
 * the stored ids above: the backend expands each to its client's agent-id set
 * (see {@link clientFilterToAgentIds}).
 */
export const CLAUDE_CLIENT_FILTER = "claude";
export const CODEX_CLIENT_FILTER = "codex";

export const ClientFilterSchema = z.enum([
  CLAUDE_CLIENT_FILTER,
  CODEX_CLIENT_FILTER,
]);

export type ClientFilter = z.infer<typeof ClientFilterSchema>;

/**
 * Everything the UI derives per known client family: its display label, the
 * provider whose logo represents it, its logs-filter value, and the
 * `external_agent_id` values it covers.
 */
export interface ClientFamily {
  filter: ClientFilter;
  label: string;
  provider: SupportedProvider;
  agentIds: ReadonlyArray<string>;
  isClientAgentId: (externalAgentId: string | null | undefined) => boolean;
}

/**
 * The known client families — the single source for every per-client piece of
 * UI/filter logic ({@link CLIENT_FILTER_OPTIONS},
 * {@link clientFilterToAgentIds}, {@link clientForExternalAgentIds}). A new
 * client family is added here, once, and inherits all of them.
 */
const CLIENT_FAMILIES: ReadonlyArray<ClientFamily> = [
  {
    filter: CLAUDE_CLIENT_FILTER,
    label: CLAUDE_CLIENT_LABEL,
    provider: "anthropic",
    agentIds: CLAUDE_CLIENT_AGENT_IDS,
    isClientAgentId: isClaudeClientAgentId,
  },
  {
    filter: CODEX_CLIENT_FILTER,
    label: CODEX_CLIENT_LABEL,
    provider: "openai",
    agentIds: CODEX_CLIENT_AGENT_IDS,
    isClientAgentId: isCodexClientAgentId,
  },
];

/**
 * The client family an interaction's `external_agent_id` list belongs to, or
 * `null` when none match. Drives the client badge on the logs table + session
 * details page (vendor logo via `provider` + `label`).
 */
export function clientForExternalAgentIds(
  externalAgentIds: ReadonlyArray<string | null | undefined>,
): ClientFamily | null {
  return (
    CLIENT_FAMILIES.find((family) =>
      externalAgentIds.some(family.isClientAgentId),
    ) ?? null
  );
}

/** The client-attribution agent ids a given filter value expands to. */
export function clientFilterToAgentIds(
  filter: ClientFilter,
): ReadonlyArray<string> {
  return (
    CLIENT_FAMILIES.find((family) => family.filter === filter)?.agentIds ?? []
  );
}

/**
 * Options for the logs "Client" filter dropdown. `provider` selects the logo
 * shown next to each option (Claude → Anthropic, Codex → OpenAI).
 */
export const CLIENT_FILTER_OPTIONS: ReadonlyArray<{
  value: ClientFilter;
  label: string;
  provider: SupportedProvider;
}> = CLIENT_FAMILIES.map(({ filter, label, provider }) => ({
  value: filter,
  label,
  provider,
}));
