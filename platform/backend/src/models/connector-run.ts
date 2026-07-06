import { and, count, desc, eq, inArray, sql, sum } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ConnectorRun,
  ConnectorRunListItem,
  InsertConnectorRun,
  UpdateConnectorRun,
} from "@/types";

class ConnectorRunModel {
  /** List runs without the `logs` column (for list endpoints). */
  static async findByConnectorList(params: {
    connectorId: string;
    limit?: number;
    offset?: number;
  }): Promise<ConnectorRunListItem[]> {
    const t = schema.connectorRunsTable;
    let query = db
      .select({
        id: t.id,
        connectorId: t.connectorId,
        status: t.status,
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
        createdAt: t.createdAt,
      })
      .from(t)
      .where(eq(t.connectorId, params.connectorId))
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

  static async countByConnector(connectorId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.connectorId, connectorId));

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
   * The reaper is the sole reclaimer, so `claim()` and the reaper can never
   * disagree about liveness (both simply treat a fresh lease as "alive"). A
   * crashed run's slot therefore frees on the next reaper pass rather than
   * instantly; given syncs run on minute-granularity cron, that latency is
   * irrelevant. Liveness is uniform across both phases: the ingest heartbeat and
   * the embedding-drain batches (see `renewLeaseForRun`) both keep the lease
   * fresh, so a healthy run — draining or not — is never reclaimed out from under
   * itself here.
   */
  static async claim(params: {
    connectorId: string;
    owner: string;
    leaseTtlSeconds: number;
  }): Promise<{ outcome: "claimed"; run: ConnectorRun } | { outcome: "busy" }> {
    const { connectorId, owner, leaseTtlSeconds } = params;
    const t = schema.connectorRunsTable;

    const [run] = await db
      .insert(t)
      .values({
        connectorId,
        status: "running",
        startedAt: sql`now()`,
        documentsProcessed: 0,
        documentsIngested: 0,
        leaseOwner: owner,
        leaseExpiresAt: sql`now() + make_interval(secs => ${leaseTtlSeconds})`,
        heartbeatAt: sql`now()`,
      })
      // Conflict on the single-flight partial index → a run already holds the
      // slot → busy. (target + predicate must match the partial unique index.)
      .onConflictDoNothing({
        target: t.connectorId,
        where: sql`status = 'running'`,
      })
      .returning();
    return run ? { outcome: "claimed", run } : { outcome: "busy" };
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

  /**
   * Drain-phase lease renewal: keep a still-running run's lease fresh while its
   * `batch_embedding` tasks drain, so liveness is uniform across both phases
   * ("is the lease fresh?"). Unlike the ingest heartbeat this is keyed only on
   * `status = 'running'` (no owner/epoch): any worker processing a batch for the
   * run may renew it, and a run that has already been reclaimed or finalized
   * (status != 'running') is never revived. No-op if the run is not running.
   */
  static async renewLeaseForRun(params: {
    runId: string;
    leaseTtlSeconds: number;
  }): Promise<void> {
    const t = schema.connectorRunsTable;
    await db
      .update(t)
      .set({
        leaseExpiresAt: sql`now() + make_interval(secs => ${params.leaseTtlSeconds})`,
        heartbeatAt: sql`now()`,
      })
      .where(and(eq(t.id, params.runId), eq(t.status, "running")));
  }

  static async completeBatch(runId: string): Promise<ConnectorRun | null> {
    const t = schema.connectorRunsTable;
    const [result] = await db
      .update(t)
      .set({
        completedBatches: sql`${t.completedBatches} + 1`,
        status: sql`CASE
          WHEN ${t.totalBatches} > 0 AND ${t.completedBatches} + 1 >= ${t.totalBatches} AND ${t.itemErrors} > 0 THEN 'completed_with_errors'
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
   * Reclaim runs whose liveness lease has expired. Liveness is uniform across a
   * run's whole life: the owning worker renews the lease during ingest (the
   * heartbeat) and any worker renews it during the embedding-drain phase (per
   * batch, via `renewLeaseForRun`). So an expired lease reliably means the run's
   * worker crashed or hung in either phase — no per-phase special-casing, and no
   * scan of the `tasks` table. Marks each reclaimed run `partial` (interrupted,
   * not an error) and bumps `leaseEpoch` to fence the dead owner. Returns the
   * reclaimed runs so the caller can resume them from their checkpoints.
   *
   * (A pathological edge remains: if a healthy run's drain stalls in the queue
   * for longer than the lease TTL with no batch processed, it is reaped early.
   * That is cosmetic only — its documents still embed idempotently and the
   * continuation is a no-op — and is bounded by keeping the TTL comfortably
   * above the batch cadence.)
   */
  static async reapExpiredRuns(): Promise<
    Array<{ id: string; connectorId: string }>
  > {
    const { rows } = await db.execute<{ id: string; connectorId: string }>(sql`
      UPDATE connector_runs r
      SET status = 'partial',
          completed_at = now(),
          lease_epoch = lease_epoch + 1,
          error = 'Sync was interrupted (worker stopped heartbeating); resuming from checkpoint.'
      WHERE r.status = 'running'
        AND r.lease_expires_at < now()
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

  /** Count runs for a connector started within the last `seconds` (crash-loop guard). */
  static async countRunsSince(
    connectorId: string,
    seconds: number,
  ): Promise<number> {
    const { rows } = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM connector_runs
      WHERE connector_id = ${connectorId}
        AND started_at > now() - make_interval(secs => ${seconds})
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

export default ConnectorRunModel;
