import { TimeInMs } from "@archestra/shared/consts";
import { LRUCacheManager } from "@/cache-manager";
import OpenAppaSessionModel from "@/models/openappa-session";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import type { OpenAppaSession } from "@/openappa/service";
import { parseTrajectoryStamp } from "@/openappa/trajectory-stamp";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import type { UnenforcedCallReason } from "@/types/openappa-unenforced";

/**
 * What OpenAPPA did not see while Guardrails enforcement was off.
 *
 * While enforcement is off, the proxy records two things:
 * - A session the runtime has no record of. It started while enforcement was
 *   off, so OpenAPPA never governs it, or any child it starts.
 * - In a session the runtime governs, each tool call the model made, and each
 *   spawn whose child ran or got a message. The runtime did not see their
 *   outcome, so OpenAPPA ignores their results after enforcement turns on.
 *
 * Only a positive record counts. A record that failed to write leaves the
 * fail-closed behavior: the runtime withholds what it has no record of.
 */

/**
 * Notes a request that the proxy sees while enforcement is off. Returns
 * `governed` when the runtime has a record of the session. Otherwise the
 * session started while enforcement was off, and the proxy records that.
 */
export async function observeUnenforcedSession(
  session: OpenAppaSession,
): Promise<"governed" | "unenforced"> {
  const key = sessionKey(session);
  const known = observed.get(key);
  if (known) return known;
  const governed = await OpenAppaSessionModel.find({
    organizationId: session.organization_id,
    sessionId: session.session_id,
  });
  if (!governed) {
    await OpenAppaUnenforcedModel.recordSession({
      organizationId: session.organization_id,
      sessionId: session.session_id,
    });
  }
  const outcome = governed ? "governed" : "unenforced";
  observed.set(key, outcome);
  return outcome;
}

/**
 * Whether the session, or a session it descends from, started while
 * enforcement was off. A session the runtime already governs is not: its
 * record lost a race with the session's first governed request. Never cached,
 * so every replica decides from the same rows.
 */
export async function startedUnenforced(
  session: OpenAppaSession,
): Promise<boolean> {
  const recorded = await OpenAppaUnenforcedModel.findSessions({
    organizationId: session.organization_id,
    sessionIds: [
      ...new Set([
        ...lineage(session.session_id),
        ...(session.parent_id ? lineage(session.parent_id) : []),
      ]),
    ],
  });
  if (recorded.length === 0) return false;
  const governed = await OpenAppaSessionModel.find({
    organizationId: session.organization_id,
    sessionId: session.session_id,
  });
  return !governed;
}

/**
 * Records tool calls whose outcome the runtime did not see, under the session
 * whose history holds them. A spawn names the child it started, when known.
 */
export async function recordUnenforcedCalls(params: {
  organizationId: string;
  sessionId: string;
  toolCallIds: readonly string[];
  reason: UnenforcedCallReason;
  childNativeId?: string;
}): Promise<void> {
  const key = (id: string) =>
    `${params.organizationId}\u0000${params.sessionId}\u0000${id}`;
  const fresh = [...new Set(params.toolCallIds.map(unenforcedCallId))].filter(
    (id) => !recordedCalls.get(key(id)),
  );
  if (fresh.length === 0) return;
  await OpenAppaUnenforcedModel.recordCalls({
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    toolCallIds: fresh,
    reason: params.reason,
    ...(params.childNativeId ? { childNativeId: params.childNativeId } : {}),
  });
  for (const id of fresh) recordedCalls.set(key(id), true);
}

/**
 * The records of a session that name one of `toolCallIds` (by the call id as
 * `unenforcedCallId` gives it) or one of `childNativeIds`. A fork also reads
 * the records of the session it continues: its history holds their calls.
 */
export async function findUnenforcedCalls(params: {
  session: OpenAppaSession;
  toolCallIds: readonly string[];
  childNativeIds?: readonly string[];
}): Promise<UnenforcedCalls> {
  const rows = await OpenAppaUnenforcedModel.findCalls({
    organizationId: params.session.organization_id,
    sessionIds: [
      params.session.session_id,
      ...(params.session.fork_of ? [params.session.fork_of] : []),
    ],
    toolCallIds: params.toolCallIds.map(unenforcedCallId),
    childNativeIds: params.childNativeIds ?? [],
  });
  return {
    reasons: new Map(rows.map((row) => [row.toolCallId, row.reason])),
    children: new Set(
      rows.flatMap((row) => (row.childNativeId ? [row.childNativeId] : [])),
    ),
  };
}

/** What a session's records say about the calls of one request. */
export type UnenforcedCalls = {
  /** Why the runtime did not see each recorded call, by call id. */
  reasons: ReadonlyMap<string, UnenforcedCallReason>;
  /** The children of recorded spawns that ran while enforcement was off. */
  children: ReadonlySet<string>;
};

/** A call id as the provider gave it: without a trajectory stamp. */
export function unenforcedCallId(id: string): string {
  return parseTrajectoryStamp(id)?.callId ?? id;
}

// ===

/**
 * The session id and the ids of the sessions it descends from. A child's id is
 * its parent's id, a colon, and the client's id of the child, after the
 * caller scope.
 */
function lineage(sessionId: string): string[] {
  const scope = sessionId.indexOf("|") + 1;
  const ids = [sessionId];
  let separator = sessionId.indexOf(":", scope + 1);
  while (separator > scope) {
    ids.push(sessionId.slice(0, separator));
    separator = sessionId.indexOf(":", separator + 1);
  }
  return ids;
}

function sessionKey(session: OpenAppaSession): string {
  return `${session.organization_id}\u0000${session.session_id}`;
}

// The caches serve only the requests seen while enforcement is off. A session
// that a racing request governs after it was cached as `unenforced` only loses
// its call records, and so keeps the fail-closed behavior.
const observed = registerProcessLocalCache(
  new LRUCacheManager<"governed" | "unenforced">({
    maxSize: 10_000,
    defaultTtl: TimeInMs.Hour,
  }),
);
const recordedCalls = registerProcessLocalCache(
  new LRUCacheManager<true>({ maxSize: 10_000, defaultTtl: TimeInMs.Hour }),
);
