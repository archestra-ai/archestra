import { and, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertRunnerSession, RunnerSession } from "@/types";

/**
 * The pod carrying one A2A task. Holds no lifecycle state of its own — the
 * task's state machine is the record of how the work is going.
 */
class RunnerSessionModel {
  static async create(session: InsertRunnerSession): Promise<RunnerSession> {
    const [created] = await db
      .insert(schema.runnerSessionsTable)
      .values(session)
      .returning();
    return created;
  }

  static async findByTaskId(taskId: string): Promise<RunnerSession | null> {
    const [session] = await db
      .select()
      .from(schema.runnerSessionsTable)
      .where(eq(schema.runnerSessionsTable.taskId, taskId))
      .limit(1);
    return session ?? null;
  }

  /** Sessions whose pod should still exist, across every organization. */
  static async listOpen(): Promise<RunnerSession[]> {
    return db
      .select()
      .from(schema.runnerSessionsTable)
      .where(isNull(schema.runnerSessionsTable.endedAt));
  }

  static async listForRunner(
    runnerId: string,
    organizationId: string,
  ): Promise<RunnerSession[]> {
    return db
      .select()
      .from(schema.runnerSessionsTable)
      .where(
        and(
          eq(schema.runnerSessionsTable.runnerId, runnerId),
          eq(schema.runnerSessionsTable.organizationId, organizationId),
        ),
      );
  }

  /**
   * Mark a session finished. Returns false when it was already closed, so a
   * caller racing the reconciler can tell whether it owns the teardown.
   */
  static async close(id: string): Promise<boolean> {
    const closed = await db
      .update(schema.runnerSessionsTable)
      .set({ endedAt: new Date() })
      .where(
        and(
          eq(schema.runnerSessionsTable.id, id),
          isNull(schema.runnerSessionsTable.endedAt),
        ),
      )
      .returning({ id: schema.runnerSessionsTable.id });
    return closed.length > 0;
  }

  static async clearVirtualApiKey(id: string): Promise<void> {
    await db
      .update(schema.runnerSessionsTable)
      .set({ virtualApiKeyId: null })
      .where(eq(schema.runnerSessionsTable.id, id));
  }
}

export default RunnerSessionModel;
