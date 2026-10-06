import type { OpenAppaSession } from "@/openappa/service";
import {
  type AppaSessionIdentity,
  type AppaWireFamily,
  appaSessionIdentity,
} from "@/openappa/wire";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaInProcessExecutorAdapter } from "./adapters/in-process-executor";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import type {
  AppaChildTrajectory,
  AppaClientAdapter,
  AppaMatchContext,
  AppaTrustedContext,
} from "./types";
import { withCallerScope } from "./utils";

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
    // After Chat, so a chatSource request is not stolen. Matches only once a
    // trusted session exists and no earlier adapter claimed the request.
    new AppaInProcessExecutorAdapter(),
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
  return adapter?.nativeSpawnParentId?.(context, params.sessionId);
}

/**
 * The runtime session of a request: the session the proxy derived, or the
 * child trajectory that the client's adapter binds the request to. A child is
 * not a client fork, so it drops a fork source the proxy derived first.
 * Throws when the child's correlation is missing, reused, or contradictory.
 */
export function appaTrajectory(params: {
  adapters: readonly AppaClientAdapter[];
  headers: AppaMatchContext["headers"];
  requestBody: unknown;
  trustedContext: AppaTrustedContext;
}): {
  session: OpenAppaSession;
  adapter: AppaClientAdapter | undefined;
  child: AppaChildTrajectory | undefined;
  matchContext: AppaMatchContext;
} {
  const trusted = params.trustedContext;
  // A copy, so no adapter can change the proxy's own context.
  const matchContext: AppaMatchContext = {
    headers: params.headers,
    requestBody: params.requestBody,
    trustedContext: { ...trusted, session: { ...trusted.session } },
  };
  const adapter = params.adapters.find((candidate) =>
    candidate.matches(matchContext),
  );
  const child = adapter?.bindChildTrajectory(matchContext);
  if (!child) {
    return { session: trusted.session, adapter, child, matchContext };
  }
  // `parent_id` and `fork_of` name runtime openings that exclude each other.
  const { fork_of: _forkOf, ...session } = trusted.session;
  return {
    session: {
      ...session,
      session_id: withCallerScope(trusted.session, child.sessionId),
      parent_id: withCallerScope(trusted.session, child.parentId),
    },
    adapter,
    child,
    matchContext,
  };
}
