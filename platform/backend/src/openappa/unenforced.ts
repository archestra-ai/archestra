import { TimeInMs } from "@archestra/shared/consts";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import OpenAppaSessionModel from "@/models/openappa-session";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import { childSessionId } from "@/openappa/actor";
import type { OpenAppaSession } from "@/openappa/service";
import { withoutTrajectoryStamp } from "@/openappa/trajectory-stamp";
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
      parentId: session.parent_id,
    });
  }
  const outcome = governed ? "governed" : "unenforced";
  observed.set(key, outcome);
  return outcome;
}

/**
 * Whether the session, or the parent that started it, started while
 * enforcement was off. A record counts only for the same parent, so a root
 * whose id spells a recorded child's id is not that child. A child of such a
 * parent is recorded too, so its own children follow it. A session the
 * runtime already governs is not: its record lost a race with the session's
 * first governed request. Never cached, so every replica decides from the
 * same rows.
 */
export async function startedUnenforced(
  session: OpenAppaSession,
): Promise<boolean> {
  const recorded = await OpenAppaUnenforcedModel.findSessions({
    organizationId: session.organization_id,
    sessionIds: [
      session.session_id,
      ...(session.parent_id ? [session.parent_id] : []),
    ],
  });
  const own = recorded.some(
    (row) =>
      row.sessionId === session.session_id &&
      (row.parentId ?? undefined) === session.parent_id,
  );
  const parent = recorded.some((row) => row.sessionId === session.parent_id);
  if (!own && !parent) return false;
  // One lookup for the session and its parent in the runtime's own rows.
  const governed = await OpenAppaSessionModel.startedSessionIds({
    organizationId: session.organization_id,
    sessionIds: [
      session.session_id,
      ...(session.parent_id ? [session.parent_id] : []),
    ],
  });
  if (governed.has(session.session_id)) return false;
  if (!own) {
    // A recorded id can belong to another session with the same spelling. A
    // parent that the runtime governs did not start while enforcement was off.
    if (session.parent_id && governed.has(session.parent_id)) return false;
    await OpenAppaUnenforcedModel.recordSession({
      organizationId: session.organization_id,
      sessionId: session.session_id,
      parentId: session.parent_id,
    });
  }
  return true;
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
  const { organizationId, sessionId } = params;
  const key = (id: string) => `${organizationId}\u0000${sessionId}\u0000${id}`;
  const fresh = [
    ...new Set(params.toolCallIds.map(withoutTrajectoryStamp)),
  ].filter((id) => !recordedCalls.get(key(id)));
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
 * The records of a session that name one of `toolCallIds` (by the call id
 * without its trajectory stamp) or one of its children in `childNativeIds`. A
 * fork reads no records of the session it continues, so what that session
 * did while enforcement was off stays withheld in the fork.
 */
export async function findUnenforcedCalls(params: {
  session: OpenAppaSession;
  toolCallIds: readonly string[];
  childNativeIds?: readonly string[];
}): Promise<UnenforcedCalls> {
  const { session } = params;
  const childNativeIds = [...new Set(params.childNativeIds ?? [])];
  const childOf = (id: string) => childSessionId(session.session_id, id);
  const [rows, startedChildren] = await Promise.all([
    OpenAppaUnenforcedModel.findCalls({
      organizationId: session.organization_id,
      sessionIds: [session.session_id],
      toolCallIds: params.toolCallIds.map(withoutTrajectoryStamp),
      childNativeIds,
    }),
    OpenAppaUnenforcedModel.findSessions({
      organizationId: session.organization_id,
      sessionIds: childNativeIds.map(childOf),
    }),
  ]);
  return {
    reasons: new Map(rows.map((row) => [row.toolCallId, row.reason])),
    children: new Set([
      ...rows.flatMap((row) => (row.childNativeId ? [row.childNativeId] : [])),
      ...childNativeIds.filter((id) =>
        startedChildren.some(
          (row) =>
            row.sessionId === childOf(id) &&
            row.parentId === session.session_id,
        ),
      ),
    ]),
  };
}

/** What a session's records say about the calls of one request. */
export type UnenforcedCalls = {
  /** Why the runtime did not see each recorded call, by call id. */
  reasons: ReadonlyMap<string, UnenforcedCallReason>;
  /**
   * The children that ran while enforcement was off: of a recorded spawn, or
   * started then.
   */
  children: ReadonlySet<string>;
};

/**
 * Deletes the records older than the retention window. A session that comes
 * back after that is one OpenAPPA has no record of, so it keeps the
 * fail-closed behavior: what the runtime did not see is withheld.
 */
export async function deleteExpiredUnenforcedRecords(
  now = new Date(),
): Promise<void> {
  const before = new Date(now.getTime() - RETENTION_DAYS * TimeInMs.Day);
  const deleted = await OpenAppaUnenforcedModel.deleteOlderThan(before);
  logger.info(
    { ...deleted, before: before.toISOString() },
    "OpenAPPA deleted expired records of what ran while Guardrails enforcement was off",
  );
}

// ===

/** How long a record lasts: longer than a session is likely to go on. */
const RETENTION_DAYS = 30;

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
