import { and, eq, inArray, lt, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertTask, Task } from "@/types";

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

  static async resetStuckTasks(timeoutMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutMs);
    const t = schema.tasksTable;

    const stuck = await db
      .select({ id: t.id, attempt: t.attempt, maxAttempts: t.maxAttempts })
      .from(t)
      .where(and(eq(t.status, "processing"), lt(t.startedAt, cutoff)));

    let count = 0;
    for (const task of stuck) {
      await TaskModel.fail({
        id: task.id,
        error: "Task timed out (stuck in processing)",
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
      });
      count++;
    }
    return count;
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
      })
      .where(and(inArray(t.id, ids), eq(t.status, "processing")))
      .returning({ id: t.id });

    // Decrement attempt for each released task so the interrupted attempt
    // doesn't count against max retries (ack-late semantics)
    for (const row of result) {
      await db.execute(
        sql`UPDATE tasks SET attempt = GREATEST(attempt - 1, 0) WHERE id = ${row.id}`,
      );
    }

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

  static async hasPendingOrProcessingForTrigger(
    taskType: string,
    triggerId: string,
  ): Promise<boolean> {
    const { rows } = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM tasks
        WHERE task_type = ${taskType}
          AND status IN ('pending', 'processing')
          AND payload->>'triggerId' = ${triggerId}
      ) AS exists
    `);
    return (rows[0] as { exists: boolean } | undefined)?.exists ?? false;
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
