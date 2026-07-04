import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertTask, Task, TaskType } from "@/types";

type StuckTaskTransition = Pick<Task, "taskType" | "periodic"> & {
  // The sweep's two UPDATEs can only produce these statuses.
  status: Extract<Task["status"], "dead" | "pending">;
};

class TaskModel {
  static async create(data: InsertTask): Promise<Task> {
    const [result] = await db
      .insert(schema.tasksTable)
      .values(data)
      .returning();
    return result;
  }

  static async dequeue(): Promise<Task | null> {
    const { rows } = await db.execute<Task>(sql`
      WITH next_task AS (
        SELECT id FROM tasks
        WHERE status = 'pending'
          AND scheduled_for <= NOW()
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tasks
      SET status = 'processing',
          started_at = NOW(),
          attempt = attempt + 1
      FROM next_task
      WHERE tasks.id = next_task.id
      RETURNING
        tasks.id,
        tasks.task_type AS "taskType",
        tasks.payload,
        tasks.status,
        tasks.attempt,
        tasks.max_attempts AS "maxAttempts",
        tasks.scheduled_for AS "scheduledFor",
        tasks.started_at AS "startedAt",
        tasks.completed_at AS "completedAt",
        tasks.last_error AS "lastError",
        tasks.periodic,
        tasks.created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  static async complete(id: string): Promise<Task | null> {
    const [result] = await db
      .update(schema.tasksTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(schema.tasksTable.id, id))
      .returning();
    return result ?? null;
  }

  static async fail(params: {
    id: string;
    error: string;
    attempt: number;
    maxAttempts: number;
  }): Promise<Task | null> {
    const { id, error, attempt, maxAttempts } = params;

    if (attempt >= maxAttempts) {
      const [result] = await db
        .update(schema.tasksTable)
        .set({
          status: "dead",
          lastError: error,
          completedAt: new Date(),
        })
        .where(eq(schema.tasksTable.id, id))
        .returning();
      return result ?? null;
    }

    // Exponential backoff: 30s * 2^(attempt-1)
    const delayMs = 30_000 * 2 ** (attempt - 1);
    const scheduledFor = new Date(Date.now() + delayMs);

    const [result] = await db
      .update(schema.tasksTable)
      .set({
        status: "pending",
        lastError: error,
        scheduledFor,
      })
      .where(eq(schema.tasksTable.id, id))
      .returning();
    return result ?? null;
  }

  /**
   * Bulk-recovers tasks stuck in `processing` past the timeout. Both UPDATEs
   * recheck status/started_at in their WHERE clause so a task that finished
   * (or was picked up again) between statements is never clobbered.
   */
  static async resetStuckTasks(
    timeoutMs: number,
  ): Promise<StuckTaskTransition[]> {
    const cutoff = new Date(Date.now() - timeoutMs);
    const timeoutError = "Task timed out (stuck in processing)";

    const { rows: dead } = await db.execute<StuckTaskTransition>(sql`
      UPDATE tasks
      SET status = 'dead',
          last_error = ${timeoutError},
          completed_at = NOW()
      WHERE status = 'processing'
        AND started_at < ${cutoff}
        AND attempt >= max_attempts
      RETURNING task_type AS "taskType", periodic, status
    `);

    // Exponential backoff computed in SQL: 30s * 2^(attempt-1)
    const { rows: retried } = await db.execute<StuckTaskTransition>(sql`
      UPDATE tasks
      SET status = 'pending',
          last_error = ${timeoutError},
          scheduled_for = NOW() + (30000 * power(2, attempt - 1)) * INTERVAL '1 millisecond'
      WHERE status = 'processing'
        AND started_at < ${cutoff}
        AND attempt < max_attempts
      RETURNING task_type AS "taskType", periodic, status
    `);

    return [...dead, ...retried];
  }

  static async releaseToQueue(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const t = schema.tasksTable;
    const result = await db
      .update(t)
      .set({
        status: "pending",
        startedAt: null,
        scheduledFor: new Date(),
        // Decrement attempt so the interrupted attempt doesn't count against
        // max retries (ack-late semantics). Must stay in this UPDATE: a
        // separate statement lets another replica dequeue in between and the
        // stale decrement would eat the new attempt's increment.
        attempt: sql`GREATEST(${t.attempt} - 1, 0)`,
      })
      .where(and(inArray(t.id, ids), eq(t.status, "processing")))
      .returning({ id: t.id });

    return result.length;
  }

  static async hasPendingOrProcessing(
    taskType: string,
    connectorId: string,
  ): Promise<boolean> {
    const { rows } = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM tasks
        WHERE task_type = ${taskType}
          AND status IN ('pending', 'processing')
          AND payload->>'connectorId' = ${connectorId}
      ) AS exists
    `);
    return (rows[0] as { exists: boolean } | undefined)?.exists ?? false;
  }

  /**
   * Batched replacement for per-entity hasPendingOrProcessing* checks: one
   * query returning every distinct payload value for active tasks of a type.
   */
  static async findActivePayloadValues(
    taskType: TaskType,
    field: "connectorId" | "triggerId",
  ): Promise<Set<string>> {
    const { rows } = await db.execute<{ value: string | null }>(sql`
      SELECT DISTINCT payload->>${field} AS value
      FROM tasks
      WHERE task_type = ${taskType}
        AND status IN ('pending', 'processing')
    `);
    return new Set(
      rows
        .map((row) => row.value)
        .filter((value): value is string => value !== null),
    );
  }

  static async hasPendingOrProcessingByType(
    taskType: string,
  ): Promise<boolean> {
    const { rows } = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM tasks
        WHERE task_type = ${taskType}
          AND status IN ('pending', 'processing')
      ) AS exists
    `);
    return (rows[0] as { exists: boolean } | undefined)?.exists ?? false;
  }
}

export default TaskModel;
