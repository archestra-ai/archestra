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

  /**
   * Dequeue the next pending task within a single lane. Filtering by the lane's
   * task types (not a global FIFO) is what stops a saturated lane from
   * head-of-line-blocking another lane's dequeue.
   */
  static async dequeue(
    laneTaskTypes: readonly TaskType[],
  ): Promise<Task | null> {
    if (laneTaskTypes.length === 0) return null;
    const types = sql.join(
      laneTaskTypes.map((type) => sql`${type}`),
      sql`, `,
    );
    const { rows } = await db.execute<Task>(sql`
      WITH next_task AS (
        SELECT id FROM tasks
        WHERE status = 'pending'
          AND scheduled_for <= NOW()
          AND task_type IN (${types})
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tasks
      SET status = 'processing',
          started_at = NOW(),
          heartbeat_at = NOW(),
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
        tasks.heartbeat_at AS "heartbeatAt",
        tasks.completed_at AS "completedAt",
        tasks.last_error AS "lastError",
        tasks.periodic,
        tasks.created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  /**
   * Renew the worker-liveness heartbeat for this worker's in-flight tasks.
   * Called every poll tick; the status guard keeps a heartbeat from reviving
   * a row some other actor already finalized or swept. Stamped with the DB
   * clock (NOW()), never a client Date — the stuck sweep compares against
   * NOW(), and a host-timezone-serialized Date would shift the effective
   * timeout by the host's UTC offset (see resetStuckTasks).
   */
  static async renewHeartbeats(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const t = schema.tasksTable;
    await db
      .update(t)
      .set({ heartbeatAt: sql`NOW()` })
      .where(and(inArray(t.id, ids), eq(t.status, "processing")));
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
   * Bulk-recovers `processing` tasks whose worker stopped heartbeating for the
   * timeout (falling back to `started_at` for rows claimed before the
   * heartbeat column existed). Staleness means the worker DIED — a healthy
   * task of any duration keeps its heartbeat fresh every poll tick — so the
   * timeout can be minutes, not an hour-scale bound on legitimate task
   * duration. Both UPDATEs recheck status/staleness in their WHERE clause so a
   * task that finished (or was picked up again) between statements is never
   * clobbered.
   *
   * The cutoff MUST be computed server-side (`NOW() - make_interval(...)`):
   * heartbeat/started_at are naked timestamps stamped with the DB clock, and a
   * client-computed Date param is serialized in the host timezone, shifting
   * the effective timeout by the host's UTC offset (on a UTC+2+ host every
   * in-flight task looked stuck within one sweep tick).
   */
  static async resetStuckTasks(
    timeoutMs: number,
  ): Promise<StuckTaskTransition[]> {
    const timeoutSeconds = timeoutMs / 1000;
    const timeoutError = "Task timed out (worker stopped heartbeating)";

    const { rows: dead } = await db.execute<StuckTaskTransition>(sql`
      UPDATE tasks
      SET status = 'dead',
          last_error = ${timeoutError},
          completed_at = NOW()
      WHERE status = 'processing'
        AND COALESCE(heartbeat_at, started_at) < NOW() - make_interval(secs => ${timeoutSeconds})
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
        AND COALESCE(heartbeat_at, started_at) < NOW() - make_interval(secs => ${timeoutSeconds})
        AND attempt < max_attempts
      RETURNING task_type AS "taskType", periodic, status
    `);

    return [...dead, ...retried];
  }

  /**
   * Requeues `permission_sync` tasks orphaned by a hard worker shutdown: rows
   * stuck in `processing` whose connector has no running permission run. A
   * genuinely in-flight pass holds a claimed run row for its whole duration
   * (dequeue → claim is seconds, covered by the grace window), so a runless
   * processing task past the grace can only be an orphan. Without this it
   * reads as "sync running" — blocking manual triggers and the scheduler —
   * until the generic 1-hour stuck sweep. Grace is DB-clock-relative for the
   * same timezone reason as resetStuckTasks.
   *
   * A crash loop can pile up several orphans per connector; a pass is
   * connector-level work, so only the newest is revived and the rest are
   * dead-lettered as superseded instead of each burning a redundant full pass.
   */
  static async requeueOrphanedPermissionSyncTasks(
    graceSeconds: number,
  ): Promise<string[]> {
    const { rows } = await db.execute<{ id: string }>(sql`
      WITH orphans AS (
        SELECT t.id,
               ROW_NUMBER() OVER (
                 PARTITION BY t.payload->>'connectorId'
                 -- Newest by creation wins the single revival. created_at ties
                 -- for back-to-back inserts (defaultNow resolution), so break
                 -- the tie by the freshest processing attempt, then by id for
                 -- an absolute deterministic order (id is a random uuid, so it
                 -- is only the final guarantee, never the primary signal).
                 ORDER BY t.created_at DESC, t.started_at DESC, t.id DESC
               ) AS rn
        FROM tasks t
        WHERE t.task_type = 'permission_sync'
          AND t.status = 'processing'
          AND t.started_at < NOW() - make_interval(secs => ${graceSeconds})
          AND NOT EXISTS (
            SELECT 1 FROM connector_runs r
            WHERE r.connector_id::text = t.payload->>'connectorId'
              AND r.run_type = 'permission'
              AND r.status = 'running'
          )
      ),
      superseded AS (
        UPDATE tasks
        SET status = 'dead',
            completed_at = NOW(),
            last_error = 'Superseded by a newer orphaned permission-sync task for the same connector'
        WHERE id IN (SELECT id FROM orphans WHERE rn > 1)
      )
      UPDATE tasks
      SET status = 'pending',
          started_at = NULL,
          scheduled_for = NOW(),
          attempt = GREATEST(attempt - 1, 0)
      WHERE id IN (SELECT id FROM orphans WHERE rn = 1)
      RETURNING id
    `);
    return rows.map((row) => row.id);
  }

  static async releaseToQueue(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const t = schema.tasksTable;
    const result = await db
      .update(t)
      .set({
        status: "pending",
        startedAt: null,
        heartbeatAt: null,
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

  /**
   * Drop all queued (pending/processing) work belonging to a connector. The
   * tasks table has no FK to connectors, so deleting a connector otherwise
   * orphans its enqueued tasks — and since batch_embedding shares the content
   * lane with connector_sync, those orphans keep occupying worker slots and
   * head-of-line-block the surviving connectors' syncs. connector_sync and
   * permission_sync carry connectorId in their payload; batch_embedding carries
   * only connectorRunId, so it is matched through the connector's runs. MUST be
   * called before the connector (and its cascade-deleted runs) are removed, or
   * the batch_embedding subquery finds nothing. Returns the number deleted.
   */
  static async deleteQueuedForConnector(connectorId: string): Promise<number> {
    const { rowCount } = await db.execute(sql`
      DELETE FROM tasks t
      WHERE t.status IN ('pending', 'processing')
        AND (
          (
            t.task_type IN ('connector_sync', 'permission_sync')
            AND t.payload->>'connectorId' = ${connectorId}
          )
          OR (
            t.task_type = 'batch_embedding'
            AND EXISTS (
              SELECT 1 FROM connector_runs r
              WHERE r.id = (t.payload->>'connectorRunId')::uuid
                AND r.connector_id = ${connectorId}::uuid
            )
          )
        )
    `);
    return rowCount ?? 0;
  }
}

export default TaskModel;
