import {
  type AppaSessionIdentity,
  type AppaWireFamily,
  appaSessionIdentity,
} from "@/openappa/wire";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { asRecord, parseJsonHeader, stringField } from "./adapters/trajectory";
import type { AppaClientAdapter, AppaMatchContext } from "./types";
import { readHeader } from "./utils";

/**
 * Client adapters in match order: external client protocols first,
 * followed by Chat loopback markers. The list is frozen and shared across the plugin.
 */
export const APPA_CLIENT_ADAPTERS: readonly AppaClientAdapter[] = Object.freeze(
  [
    new AppaClaudeCodeAdapter(),
    new AppaCodexAdapter(),
    new AppaOpenCodeAdapter(),
    new AppaChatAdapter(),
  ],
);

/**
 * Resolves session identity for a request using matched client adapters.
 *
 * Precedence:
 * 1. An explicit `X-Appa-Session-ID` header.
 * 2. Native client signals (Claude Code header, Codex metadata, OpenCode headers).
 * 3. Generic wire-family fallbacks.
 *
 * When provided, `X-Appa-Parent-ID` overrides any native parent ID.
 */
export function extractAppaSessionIdentity(params: {
  family: AppaWireFamily;
  body: unknown;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}): AppaSessionIdentity {
  const generic = appaSessionIdentity(params);
  if (generic.provenance === "appa-header") return generic;
  const adapter = APPA_CLIENT_ADAPTERS.find((candidate) =>
    candidate.matches({
      headers: params.headers,
      requestBody: params.body,
    }),
  );
  const native = adapter?.extractSessionIdentity?.({
    headers: params.headers,
    requestBody: params.body,
  });
  if (!native?.sessionId) return generic;
  return {
    ...native,
    parentId: generic.parentId ?? native.parentId,
  };
}

/**
 * Returns the native parent of a child prepared for spawn, when the client
 * names a parent different from this request session.
 * Used to skip fork tracing because children replay parent receipts and stamps.
 *
 * Does not write X-Appa-Parent-ID. That header is a host claim, and an
 * unprepared parent ID is refused at session start.
 */
export function nativeSpawnParentId(params: {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: unknown;
  sessionId: string | undefined;
}): string | undefined {
  if (!params.sessionId) return undefined;
  const context = { headers: params.headers, requestBody: params.body };
  const adapter = APPA_CLIENT_ADAPTERS.find((candidate) =>
    candidate.matches(context),
  );
  if (adapter instanceof AppaClaudeCodeAdapter)
    return adapter.nativeSpawnParentId(context, params.sessionId);
  if (adapter?.id === "codex")
    return codexSpawnParentId(context, params.sessionId);
  if (adapter?.id === "opencode")
    return openCodeSpawnParentId(context, params.sessionId);
  return undefined;
}

function namedParent(
  parent: string | undefined,
  sessionId: string,
): string | undefined {
  return parent && parent !== sessionId ? parent : undefined;
}

function codexSpawnParentId(
  context: AppaMatchContext,
  sessionId: string,
): string | undefined {
  const turn = parseJsonHeader(context.headers, "x-codex-turn-metadata");
  const fromTurn =
    stringField(turn?.parent_thread_id) ?? stringField(turn?.parent_id);
  if (fromTurn) return namedParent(fromTurn, sessionId);
  const body = asRecord(context.requestBody);
  const metadata = asRecord(body?.client_metadata) ?? asRecord(body?.metadata);
  return namedParent(
    stringField(metadata?.parent_thread_id) ?? stringField(metadata?.parent_id),
    sessionId,
  );
}

function openCodeSpawnParentId(
  context: AppaMatchContext,
  sessionId: string,
): string | undefined {
  const metadata = asRecord(asRecord(context.requestBody)?.metadata);
  return namedParent(
    readHeader(context.headers, "x-parent-session-id") ??
      stringField(metadata?.parent_id) ??
      stringField(metadata?.parentID) ??
      stringField(metadata?.parent_session_id),
    sessionId,
  );
}
