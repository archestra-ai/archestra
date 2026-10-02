import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { UnenforcedCallReason } from "@/types/openappa-unenforced";

const sessions = schema.openappaUnenforcedSessionsTable;
const calls = schema.openappaUnenforcedCallsTable;

/**
 * The parts of sessions that ran while Guardrails enforcement was off. The
 * proxy records them while enforcement is off, and OpenAPPA ignores them after
 * it turns on. A record never changes, so a second write of it does nothing.
 */
class OpenAppaUnenforcedModel {
  static async recordSession(params: {
    organizationId: string;
    sessionId: string;
    parentId: string | undefined;
  }): Promise<void> {
    await db
      .insert(sessions)
      .values({
        organizationId: params.organizationId,
        sessionId: params.sessionId,
        parentId: params.parentId ?? null,
      })
      .onConflictDoNothing();
  }

  /** The sessions among `sessionIds` that started while enforcement was off. */
  static async findSessions(params: {
    organizationId: string;
    sessionIds: readonly string[];
  }): Promise<Array<{ sessionId: string; parentId: string | null }>> {
    if (params.sessionIds.length === 0) return [];
    return db
      .select({ sessionId: sessions.sessionId, parentId: sessions.parentId })
      .from(sessions)
      .where(
        and(
          eq(sessions.organizationId, params.organizationId),
          inArray(sessions.sessionId, [...new Set(params.sessionIds)]),
        ),
      );
  }

  static async recordCalls(params: {
    organizationId: string;
    sessionId: string;
    toolCallIds: readonly string[];
    reason: UnenforcedCallReason;
    childNativeId?: string;
  }): Promise<void> {
    if (params.toolCallIds.length === 0) return;
    await db
      .insert(calls)
      .values(
        [...new Set(params.toolCallIds)].map((toolCallId) => ({
          organizationId: params.organizationId,
          sessionId: params.sessionId,
          toolCallId,
          reason: params.reason,
          childNativeId: params.childNativeId ?? null,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Deletes the records written before `before`, `batchSize` rows per
   * statement so that no single delete holds locks for long, and says how
   * many went. One sweep deletes at most `maxBatches` batches per table; the
   * next sweep takes the rest.
   */
  static async deleteOlderThan(
    before: Date,
    batchSize = 1000,
    maxBatches = 100,
  ): Promise<{ sessions: number; calls: number }> {
    const limits = { before, batchSize, maxBatches };
    return {
      sessions: await deleteInBatches(sessions, limits),
      calls: await deleteInBatches(calls, limits),
    };
  }

  /**
   * The records of `sessionIds` that name one of `toolCallIds` or
   * `childNativeIds`. The ids come from one request, so the lists are no
   * longer than its tool results.
   */
  static async findCalls(params: {
    organizationId: string;
    sessionIds: readonly string[];
    toolCallIds: readonly string[];
    childNativeIds?: readonly string[];
  }): Promise<
    Array<{
      toolCallId: string;
      reason: UnenforcedCallReason;
      childNativeId: string | null;
    }>
  > {
    const toolCallIds = [...new Set(params.toolCallIds)];
    const childNativeIds = [...new Set(params.childNativeIds ?? [])];
    if (
      params.sessionIds.length === 0 ||
      (toolCallIds.length === 0 && childNativeIds.length === 0)
    )
      return [];
    return db
      .select({
        toolCallId: calls.toolCallId,
        reason: calls.reason,
        childNativeId: calls.childNativeId,
      })
      .from(calls)
      .where(
        and(
          eq(calls.organizationId, params.organizationId),
          inArray(calls.sessionId, [...params.sessionIds]),
          or(
            toolCallIds.length > 0
              ? inArray(calls.toolCallId, toolCallIds)
              : undefined,
            childNativeIds.length > 0
              ? inArray(calls.childNativeId, childNativeIds)
              : undefined,
          ),
        ),
      );
  }
}

/**
 * The tables have composite keys, so a batch names its rows by `ctid`. The
 * select is a subquery of the delete, so a row cannot move between the two;
 * keep them one statement.
 */
async function deleteInBatches(
  table: typeof sessions | typeof calls,
  params: { before: Date; batchSize: number; maxBatches: number },
): Promise<number> {
  const { before, batchSize, maxBatches } = params;
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const expired = db
      .select({ ctid: sql`ctid` })
      .from(table)
      .where(lt(table.createdAt, before))
      .limit(batchSize);
    const removed = await db
      .delete(table)
      .where(inArray(sql`ctid`, expired))
      .returning({ createdAt: table.createdAt });
    total += removed.length;
    if (removed.length < batchSize) break;
  }
  return total;
}

export default OpenAppaUnenforcedModel;
