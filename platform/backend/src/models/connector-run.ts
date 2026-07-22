import { and, count, desc, eq, inArray, ne, sql, sum } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ConnectorRun,
  ConnectorRunListItem,
  ConnectorRunType,
  ConnectorSyncStatus,
  InsertConnectorRun,
  UpdateConnectorRun,
} from "@/types";

class ConnectorRunModel {
  /** List runs without the `logs` column (for list endpoints). */
  static async findByConnectorList(params: {
    connectorId: string;
    limit?: number;
    offset?: number;
    /** When set, restrict to one job family (content|permission). */
    runType?: ConnectorRunType;
    status?: ConnectorSyncStatus;
    result?: ConnectorRunResultFilter;
  }): Promise<ConnectorRunListItem[]> {
    const t = schema.connectorRunsTable;
    let query = db
      .select({
        id: t.id,
        connectorId: t.connectorId,
        status: t.status,
        runType: t.runType,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        documentsProcessed: t.documentsProcessed,
        documentsIngested: t.documentsIngested,
        totalItems: t.totalItems,
        totalBatches: t.totalBatches,
        completedBatches: t.completedBatches,
        itemErrors: t.itemErrors,
        itemsSkipped: t.itemsSkipped,
        error: t.error,
        checkpoint: t.checkpoint,
        stats: t.stats,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          params.runType ? eq(t.runType, params.runType) : undefined,
          params.status ? eq(t.status, params.status) : undefined,
          runResultFilter(params.result),
        ),
      )
      .orderBy(desc(t.startedAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findByConnector(params: {
    connectorId: string;
    limit?: number;
    offset?: number;
  }): Promise<ConnectorRun[]> {
    let query = db
      .select()
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.connectorId, params.connectorId))
      .orderBy(desc(schema.connectorRunsTable.startedAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async countByConnector(params: {
    connectorId: string;
    runType?: ConnectorRunType;
    status?: ConnectorSyncStatus;
    result?: ConnectorRunResultFilter;
  }): Promise<number> {
    const t = schema.connectorRunsTable;
    const [result] = await db
      .select({ count: count() })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          params.runType ? eq(t.runType, params.runType) : undefined,
          params.status ? eq(t.status, params.status) : undefined,
          runResultFilter(params.result),
        ),
      );

    return result?.count ?? 0;
  }

  static async findById(id: string): Promise<ConnectorRun | null> {
    const [result] = await db
      .select()
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.id, id));

    return result ?? null;
  }

  static async create(data: InsertConnectorRun): Promise<ConnectorRun> {
    const [result] = await db
      .insert(schema.connectorRunsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateConnectorRun>,
  ): Promise<ConnectorRun | null> {
    const [result] = await db
      .update(schema.connectorRunsTable)
      .set(data)
      .where(eq(schema.connectorRunsTable.id, id))
      .returning();

    return result ?? null;
  }

  /**
   * Start a new run for a connector under the single-flight invariant (unique
   * partial index on connector_id WHERE status='running'). Returns the claimed
   * run with its lease, or `{ outcome: "busy" }` if a `running` run already holds
   * the slot.
   *
   * This is a pure insert-or-skip — it does NOT reclaim an expired-lease run.
   * The reaper is the sole reclaimer, so `claim()` never fences a run out from
   * under a possibly-live owner; a crashed run's slot frees on the next reaper
   * pass rather than instantly, which is irrelevant at minute-granularity cron.
   */
  static async claim(params: {
    connectorId: string;
    owner: string;
    leaseTtlSeconds: number;
    /**
     * Which job family to claim. `content` (default) and `permission`
     * single-flight independently: a content run and a permission run for the
     * same connector can both be `running`; two runs of the same family cannot.
     */
    runType?: ConnectorRunType;
  }): Promise<{ outcome: "claimed"; run: ConnectorRun } | { outcome: "busy" }> {
    const { connectorId, owner, leaseTtlSeconds, runType = "content" } = params;
    const t = schema.connectorRunsTable;

    const [run] = await db
      .insert(t)
      .values({
        connectorId,
        runType,
        status: "running",
        startedAt: sql`now()`,
        documentsProcessed: 0,
        documentsIngested: 0,
        leaseOwner: owner,
        leaseExpiresAt: sql`now() + make_interval(secs => ${leaseTtlSeconds})`,
        heartbeatAt: sql`now()`,
      })
      // Conflict on the composite single-flight partial index → a run of the
      // same family already holds the slot → busy. (target + predicate must
      // match the partial unique index (connector_id, run_type) WHERE running.)
      .onConflictDoNothing({
        target: [t.connectorId, t.runType],
        where: sql`status = 'running'`,
      })
      .returning();
    return run ? { outcome: "claimed", run } : { outcome: "busy" };
  }

  /** Whether a run of the given family is currently `running` for the connector. */
  static async hasRunningRun(params: {
    connectorId: string;
    runType: ConnectorRunType;
  }): Promise<boolean> {
    const t = schema.connectorRunsTable;
    const [row] = await db
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          eq(t.runType, params.runType),
          eq(t.status, "running"),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * The checkpoint a freshly-claimed run of `runType` should resume from, or
   * null. `claim` inserts a brand-new run with no checkpoint, so on a re-enqueue
   * that follows an interrupted run (the reaper marked it `partial`) we adopt
   * that run's last checkpoint to continue the SAME generation from its cursor —
   * re-touching only the un-processed tail rather than restarting the reconcile.
   * Only resumes when the MOST RECENT terminal (non-`running`) run of the family
   * is `partial`: after a successful run there is nothing to resume, so a stale
   * older partial is never re-adopted. Excludes the just-claimed run.
   */
  static async findResumableCheckpoint(params: {
    connectorId: string;
    runType: ConnectorRunType;
    excludeRunId: string;
  }): Promise<unknown | null> {
    const t = schema.connectorRunsTable;
    const [latest] = await db
      .select({ status: t.status, checkpoint: t.checkpoint })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          eq(t.runType, params.runType),
          ne(t.id, params.excludeRunId),
          ne(t.status, "running"),
        ),
      )
      .orderBy(desc(t.startedAt))
      .limit(1);
    if (!latest || latest.status !== "partial") return null;
    return latest.checkpoint ?? null;
  }

  /**
   * Update a run only while the caller still owns its current lease generation
   * (status still `running` AND `lease_epoch` unchanged). Returns `null` if the
   * run was reclaimed/finalized — the fencing signal that tells a paused-then-
   * revived owner to stop writing (its epoch is now stale).
   */
  static async updateIfOwned(params: {
    runId: string;
    epoch: number;
    data: Partial<UpdateConnectorRun>;
  }): Promise<ConnectorRun | null> {
    const t = schema.connectorRunsTable;
    const [result] = await db
      .update(t)
      .set(params.data)
      .where(
        and(
          eq(t.id, params.runId),
          eq(t.status, "running"),
          eq(t.leaseEpoch, params.epoch),
        ),
      )
      .returning();
    return result ?? null;
  }

  /**
   * Ingest-phase heartbeat: extend the lease, fenced by owner + epoch. Returns
   * `false` if the caller no longer owns the run (reclaimed) — abort work.
   */
  static async renewLease(params: {
    runId: string;
    owner: string;
    epoch: number;
    leaseTtlSeconds: number;
  }): Promise<boolean> {
    const t = schema.connectorRunsTable;
    const [result] = await db
      .update(t)
      .set({
        leaseExpiresAt: sql`now() + make_interval(secs => ${params.leaseTtlSeconds})`,
        heartbeatAt: sql`now()`,
      })
      .where(
        and(
          eq(t.id, params.runId),
          eq(t.status, "running"),
          eq(t.leaseOwner, params.owner),
          eq(t.leaseEpoch, params.epoch),
        ),
      )
      .returning({ id: t.id });
    return !!result;
  }

  static async completeBatch(
    runId: string,
    /**
     * An embedding batch failure to record on the run, atomically with the batch
     * completion. `failedItems` is added to `itemErrors` (which drives the
     * completed_with_errors status); `error` is recorded as the run error, keeping
     * any earlier error. Recording via a separate read-then-write would race with
     * concurrent batch handlers, so it happens in this single UPDATE.
     */
    failure?: { failedItems: number; error: string },
  ): Promise<ConnectorRun | null> {
    const t = schema.connectorRunsTable;
    const failedItems = failure?.failedItems ?? 0;
    const [result] = await db
      .update(t)
      .set({
        completedBatches: sql`${t.completedBatches} + 1`,
        itemErrors: sql`${t.itemErrors} + ${failedItems}`,
        ...(failure?.error
          ? { error: sql`COALESCE(${t.error}, ${failure.error})` }
          : {}),
        // Include this batch's failures in the terminal-status decision — SET
        // expressions all see the pre-update row, so add `failedItems` explicitly.
        status: sql`CASE
          WHEN ${t.totalBatches} > 0 AND ${t.completedBatches} + 1 >= ${t.totalBatches} AND ${t.itemErrors} + ${failedItems} > 0 THEN 'completed_with_errors'
          WHEN ${t.totalBatches} > 0 AND ${t.completedBatches} + 1 >= ${t.totalBatches} THEN 'success'
          ELSE ${t.status}
        END`,
        completedAt: sql`CASE WHEN ${t.totalBatches} > 0 AND ${t.completedBatches} + 1 >= ${t.totalBatches} THEN NOW() ELSE ${t.completedAt} END`,
      })
      // Only advance a still-running run. Orphaned embedding batches belonging
      // to a superseded/failed run must not bump its counters or resurrect it.
      .where(and(eq(t.id, runId), eq(t.status, "running")))
      .returning();
    return result ?? null;
  }

  /**
   * Atomically checks if all batches are complete and transitions the run to
   * success/completed_with_errors. Called after totalBatches is set to handle
   * the case where all batches completed before totalBatches was written.
   */
  static async finalizeBatchesIfComplete(
    runId: string,
  ): Promise<ConnectorRun | null> {
    const t = schema.connectorRunsTable;
    const [result] = await db
      .update(t)
      .set({
        status: sql`CASE
          WHEN ${t.status} != 'running' THEN ${t.status}
          WHEN ${t.totalBatches} > 0 AND ${t.completedBatches} >= ${t.totalBatches} AND ${t.itemErrors} > 0 THEN 'completed_with_errors'
          WHEN ${t.totalBatches} > 0 AND ${t.completedBatches} >= ${t.totalBatches} THEN 'success'
          ELSE ${t.status}
        END`,
        completedAt: sql`CASE WHEN ${t.status} = 'running' AND ${t.totalBatches} > 0 AND ${t.completedBatches} >= ${t.totalBatches} THEN NOW() ELSE ${t.completedAt} END`,
      })
      .where(eq(t.id, runId))
      .returning();
    return result ?? null;
  }

  /**
   * Reclaim runs whose worker died, distinguished per phase:
   *  - ingest: the owning worker renews the lease via a heartbeat, so an expired
   *    lease means it crashed/hung;
   *  - embedding drain: the lease is no longer renewed (ingest is done), so
   *    liveness is instead the existence of pending/processing `batch_embedding`
   *    tasks. A run whose batches are still queued — even behind a backlog — is
   *    draining, not dead, so it is skipped here regardless of its lease. This is
   *    the only signal that reflects *queued* (not just in-progress) work, which
   *    no run-row field can: skipping it is why a slow drain is never reaped early.
   * A run is reclaimed only when its lease has expired AND no batch_embedding work
   * remains, which reliably means a dead worker (or, for a drain whose batch tasks
   * died terminally, a run whose stuck documents the embedding-recovery sweep
   * re-enqueues). Marks each `partial` and bumps `leaseEpoch` to fence the dead
   * owner; returns them so the caller can resume from checkpoint.
   *
   * The subquery only runs for the few expired-lease running runs (filtered first
   * by the partial `connector_runs_lease_expires_at_idx`) and hits
   * `tasks_dequeue_idx` on (task_type, status), so it is not a table scan.
   */
  static async reapExpiredRuns(
    runType: ConnectorRunType = "content",
  ): Promise<Array<{ id: string; connectorId: string }>> {
    const { rows } = await db.execute<{ id: string; connectorId: string }>(sql`
      UPDATE connector_runs r
      SET status = 'partial',
          completed_at = now(),
          lease_epoch = lease_epoch + 1,
          error = 'Sync was interrupted (worker stopped heartbeating); resuming from checkpoint.'
      WHERE r.status = 'running'
        AND r.run_type = ${runType}
        AND r.lease_expires_at < now()
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.task_type = 'batch_embedding'
            AND t.status IN ('pending', 'processing')
            AND t.payload->>'connectorRunId' = r.id::text
        )
      RETURNING r.id, r.connector_id AS "connectorId"
    `);
    return rows;
  }

  static async deleteByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.connectorId, connectorId));

    return result.rowCount ?? 0;
  }

  /**
   * Count one family's runs for a connector started within the last `seconds`
   * (crash-loop guard). Scoped by `runType` so the content and permission
   * families each draw on their own resume budget — a healthy half-hourly
   * permission cadence must not eat into the content budget, nor vice versa.
   */
  static async countRunsSince(params: {
    connectorId: string;
    seconds: number;
    runType: ConnectorRunType;
  }): Promise<number> {
    const { rows } = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM connector_runs
      WHERE connector_id = ${params.connectorId}
        AND run_type = ${params.runType}
        AND started_at > now() - make_interval(secs => ${params.seconds})
    `);
    return rows[0]?.count ?? 0;
  }

  static async sumDocsIngestedByConnector(
    connectorId: string,
  ): Promise<number> {
    const [result] = await db
      .select({ total: sum(schema.connectorRunsTable.documentsIngested) })
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.connectorId, connectorId));

    return Number(result?.total ?? 0);
  }

  static async sumDocsIngestedByKnowledgeBaseIds(
    knowledgeBaseIds: string[],
  ): Promise<Map<string, number>> {
    if (knowledgeBaseIds.length === 0) return new Map();

    const results = await db
      .select({
        knowledgeBaseId:
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
        total: sum(schema.connectorRunsTable.documentsIngested),
      })
      .from(schema.connectorRunsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.connectorRunsTable.connectorId,
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
        ),
      )
      .where(
        inArray(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          knowledgeBaseIds,
        ),
      )
      .groupBy(schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId);

    return new Map(
      results.map((r) => [r.knowledgeBaseId, Number(r.total ?? 0)]),
    );
  }
}

/** "changes" keeps runs that changed anything; "no-changes" the rest. */
type ConnectorRunResultFilter = "changes" | "no-changes";

/**
 * Whether a run changed anything, mirroring the Sync Runs Result cell:
 * a documents run changed something when it ingested documents; a
 * permission run when any of its change counters is non-zero.
 */
function runResultFilter(result: ConnectorRunResultFilter | undefined) {
  if (!result) return undefined;
  const t = schema.connectorRunsTable;
  const changed = sql`(
    (${t.runType} = 'content' AND COALESCE(${t.documentsIngested}, 0) > 0)
    OR (${t.runType} = 'permission' AND (
      COALESCE((${t.stats}->>'aclsChanged')::int, 0) > 0
      OR COALESCE((${t.stats}->>'containersChanged')::int, 0) > 0
      OR COALESCE((${t.stats}->>'membershipsUpserted')::int, 0) > 0
      OR COALESCE((${t.stats}->>'membershipsRemoved')::int, 0) > 0
      OR COALESCE((${t.stats}->>'failClosed')::int, 0) > 0
    ))
  )`;
  return result === "changes" ? changed : sql`NOT ${changed}`;
}

export default ConnectorRunModel;
