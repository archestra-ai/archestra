import {
  type AppaSessionIdentity,
  type AppaWireFamily,
  appaSessionIdentity,
} from "@/openappa/wire";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import type { AppaClientAdapter } from "./types";

/**
 * The proxy's client adapters, in match order: externally declared client
 * protocols first, Chat's trusted loopback marker last so incidental SDK
 * headers keep their native syntax. The instances are stateless, so one
 * frozen list serves both the plugin and session extraction.
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
 * The session this request belongs to, as the matched client adapter reads it
 * from the client's own trajectory signals.
 *
 * Precedence: an explicit `X-Appa-Session-ID` always wins (Chat, the
 * qualification harness, deliberate root managers); then the matched
 * adapter's native extraction — Claude Code's session header, Codex's turn
 * metadata, OpenCode's session headers — which carries the client's
 * fork/resume/compaction semantics; then the generic wire-family fallbacks
 * for every other client. `X-Appa-Parent-ID` passes through with any
 * provenance.
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
