import type { OpenCodeFamilyTurnKind } from "@archestra/shared";
import { OPENCODE_AGENT_HEADER } from "@archestra/shared/consts";
import {
  isOpenCodeFamilyClient,
  type OpenCodeFamilyClientId,
} from "@archestra/shared/opencode-family";
import {
  detectClaudeClientId,
  detectCodexClientId,
  detectCursorClientId,
  detectKiloClientId,
  detectKimiCodeClientId,
  detectOpenCodeClientId,
} from "./client-app";
import { getExternalAgentId } from "./external-agent-id";
import { getHeaderValue } from "./meta-header";
import { extractSessionInfo, type SessionInfo } from "./session-id";

type Headers = Record<string, string | string[] | undefined>;

/**
 * The subset of a proxied request body read for session-id and client-app
 * extraction. Each consumer only touches its own fields (`detectClaudeClientId`
 * → `system`/`metadata`; `detectCodexClientId` → `client_metadata`;
 * `extractSessionInfo` → `metadata`/`user`/`client_metadata`), so one shared
 * view keeps the cast in a single place.
 */
export type RequestBodyForExtraction =
  | {
      system?: unknown;
      metadata?: { user_id?: string | null };
      user?: string | null;
      client_metadata?: unknown;
    }
  | undefined;

export interface AutoRoutingSessionMetadata extends SessionInfo {
  /** Resolved client attribution; null when no known client was detected. */
  client: string | null;
}

/**
 * Client-app attribution: the caller-supplied X-Archestra-Agent-Id header (or
 * X-Archestra-Meta segment 0) wins; otherwise auto-discover a known client app
 * (Claude from the body; Codex from client_metadata or its originator/User-Agent;
 * OpenCode, Kilo Code, Kimi Code and Cursor from their identity headers).
 */
export function detectClientApp(
  headers: Headers,
  body: RequestBodyForExtraction,
): string | undefined {
  return (
    getExternalAgentId(headers) ??
    detectClaudeClientId(body) ??
    detectCodexClientId(headers, body) ??
    detectOpenCodeClientId(headers) ??
    detectKiloClientId(headers) ??
    detectKimiCodeClientId(headers) ??
    detectCursorClientId(headers)
  );
}

/** How an OpenCode-family client framed this turn; undefined for other clients. */
export function detectOpenCodeFamilyTurn(
  headers: Headers,
  client: string | undefined,
):
  | { clientId: OpenCodeFamilyClientId; kind: OpenCodeFamilyTurnKind }
  | undefined {
  if (!client || !isOpenCodeFamilyClient(client)) return undefined;
  const agent = getHeaderValue(headers, OPENCODE_AGENT_HEADER);
  const kind: OpenCodeFamilyTurnKind = getHeaderValue(
    headers,
    "x-parent-session-id",
  )
    ? "subagent"
    : agent === "title" || agent === "compaction"
      ? agent
      : "main";
  return { clientId: client, kind };
}

export function extractAutoRoutingSessionMetadata({
  headers,
  body: rawBody,
}: {
  headers: Headers;
  /** The original provider request body (Chat Completions or Responses). */
  body: unknown;
}): AutoRoutingSessionMetadata {
  const body = rawBody as RequestBodyForExtraction;
  const client = detectClientApp(headers, body);
  const { sessionId, sessionSource } = extractSessionInfo({
    headers,
    body,
    externalAgentId: client,
  });
  return { sessionId, sessionSource, client: client ?? null };
}
