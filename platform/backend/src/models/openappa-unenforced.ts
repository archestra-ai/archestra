import { and, eq, inArray } from "drizzle-orm";
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
  }): Promise<void> {
    await db
      .insert(sessions)
      .values({
        organizationId: params.organizationId,
        sessionId: params.sessionId,
      })
      .onConflictDoNothing();
  }

  /** The caller-scoped session ids of `sessionIds` that started while enforcement was off. */
  static async findSessions(params: {
    organizationId: string;
    sessionIds: readonly string[];
  }): Promise<string[]> {
    if (params.sessionIds.length === 0) return [];
    const rows = await db
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(
        and(
          eq(sessions.organizationId, params.organizationId),
          inArray(sessions.sessionId, [...params.sessionIds]),
        ),
      );
    return rows.map((row) => row.sessionId);
  }

  static async recordCalls(params: {
    organizationId: string;
    callerId: string | undefined;
    toolCallIds: readonly string[];
    reason: UnenforcedCallReason;
  }): Promise<void> {
    if (params.toolCallIds.length === 0) return;
    await db
      .insert(calls)
      .values(
        [...new Set(params.toolCallIds)].map((toolCallId) => ({
          organizationId: params.organizationId,
          callerId: params.callerId ?? "",
          toolCallId,
          reason: params.reason,
        })),
      )
      .onConflictDoNothing();
  }

  /** The recorded calls among `toolCallIds`, with the reason of each. */
  static async findCalls(params: {
    organizationId: string;
    callerId: string | undefined;
    toolCallIds: readonly string[];
  }): Promise<Map<string, UnenforcedCallReason>> {
    const found = new Map<string, UnenforcedCallReason>();
    if (params.toolCallIds.length === 0) return found;
    const rows = await db
      .select({ toolCallId: calls.toolCallId, reason: calls.reason })
      .from(calls)
      .where(
        and(
          eq(calls.organizationId, params.organizationId),
          eq(calls.callerId, params.callerId ?? ""),
          inArray(calls.toolCallId, [...new Set(params.toolCallIds)]),
        ),
      );
    for (const row of rows) found.set(row.toolCallId, row.reason);
    return found;
  }
}

export default OpenAppaUnenforcedModel;
