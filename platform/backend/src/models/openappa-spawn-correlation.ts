import { and, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";

const operations = schema.openappaOperationsTable;
const sessions = schema.openappaSessionsTable;

class OpenAppaSpawnCorrelationModel {
  /**
   * Recovers only the signed spawn binding stored with a child's own event.
   * A parent's sole open call could belong to a different async child.
   */
  static async soleOpenSpawn(params: {
    organizationId: string;
    callerId: string | undefined;
    parentSessionId: string;
    childSessionId: string;
  }): Promise<string | null> {
    const callerScope = params.callerId
      ? eq(sessions.callerId, params.callerId)
      : isNull(sessions.callerId);
    const [binding] = await db
      .select({ actor: sessions.actor })
      .from(sessions)
      .where(
        and(
          eq(sessions.organizationId, params.organizationId),
          eq(sessions.sessionId, params.childSessionId),
          eq(sessions.parentId, params.parentSessionId),
          callerScope,
        ),
      )
      .limit(1);
    if (!binding) return null;
    const storedCallId = sql<string>`COALESCE(${operations.input}->'semantic'->>'spawn_call_id', ${operations.input}->>'spawn_call_id')`;
    const rows = await db
      .selectDistinct({ toolCallId: storedCallId })
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.childSessionId),
          eq(operations.status, "complete"),
          params.callerId
            ? eq(operations.callerId, params.callerId)
            : isNull(operations.callerId),
          sql`COALESCE(${operations.input}->'semantic'->>'event', ${operations.input}->>'event') IN ('prompt', 'tool_call')`,
          sql`${storedCallId} IS NOT NULL`,
        ),
      )
      .limit(2);
    if (rows.length !== 1) return null;

    const allowed = await OpenAppaSpawnCorrelationModel.allowedSpawn({
      organizationId: params.organizationId,
      callerId: params.callerId,
      parentSessionId: params.parentSessionId,
      spawnCallId: rows[0].toolCallId,
    });
    return allowed ? rows[0].toolCallId : null;
  }

  /** Whether the runtime allowed `spawnCallId` as a spawn in the parent session. */
  static async allowedSpawn(params: {
    organizationId: string;
    callerId: string | undefined;
    parentSessionId: string;
    spawnCallId: string;
  }): Promise<boolean> {
    const [spawn] = await db
      .select({ operationId: operations.operationId })
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.parentSessionId),
          eq(operations.operationId, `call:${params.spawnCallId}`),
          eq(operations.status, "complete"),
          params.callerId
            ? eq(operations.callerId, params.callerId)
            : isNull(operations.callerId),
          sql`COALESCE(${operations.input}->'semantic'->>'spawn', ${operations.input}->>'spawn') = 'true'`,
          sql`${operations.decision}->>'decision' = 'allow_call'`,
        ),
      )
      .limit(1);
    return spawn !== undefined;
  }
}

export default OpenAppaSpawnCorrelationModel;
