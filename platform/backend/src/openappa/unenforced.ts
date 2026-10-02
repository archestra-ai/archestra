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
 * record lost a race with the session's first governed request.
 */
export async function startedUnenforced(
  session: OpenAppaSession,
): Promise<boolean> {
  const key = sessionKey(session);
  if (unenforcedStarts.get(key)) return true;
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
  if (governed) return false;
  unenforcedStarts.set(key, true);
  return true;
}

/** Records tool calls of a governed session whose outcome the runtime did not see. */
export async function recordUnenforcedCalls(params: {
  session: OpenAppaSession;
  toolCallIds: readonly string[];
  reason: UnenforcedCallReason;
}): Promise<void> {
  const { session } = params;
  const fresh = [...new Set(params.toolCallIds.map(unenforcedCallId))].filter(
    (id) => !recordedCalls.get(callKey(session, id)),
  );
  if (fresh.length === 0) return;
  await OpenAppaUnenforcedModel.recordCalls({
    organizationId: session.organization_id,
    callerId: session.caller_id,
    toolCallIds: fresh,
    reason: params.reason,
  });
  for (const id of fresh) recordedCalls.set(callKey(session, id), true);
}

/**
 * The recorded calls among `toolCallIds` of this session's caller, by the
 * call id as `unenforcedCallId` gives it.
 */
export async function findUnenforcedCalls(params: {
  session: OpenAppaSession;
  toolCallIds: readonly string[];
}): Promise<ReadonlyMap<string, UnenforcedCallReason>> {
  return OpenAppaUnenforcedModel.findCalls({
    organizationId: params.session.organization_id,
    callerId: params.session.caller_id,
    toolCallIds: params.toolCallIds.map(unenforcedCallId),
  });
}

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

function callKey(session: OpenAppaSession, id: string): string {
  return `${session.organization_id}\u0000${session.caller_id ?? ""}\u0000${id}`;
}

// Each entry is a fact that never changes, so a cached entry is never stale.
const observed = registerProcessLocalCache(
  new LRUCacheManager<"governed" | "unenforced">({
    maxSize: 10_000,
    defaultTtl: TimeInMs.Hour,
  }),
);
const unenforcedStarts = registerProcessLocalCache(
  new LRUCacheManager<true>({ maxSize: 10_000, defaultTtl: TimeInMs.Hour }),
);
const recordedCalls = registerProcessLocalCache(
  new LRUCacheManager<true>({ maxSize: 10_000, defaultTtl: TimeInMs.Hour }),
);
