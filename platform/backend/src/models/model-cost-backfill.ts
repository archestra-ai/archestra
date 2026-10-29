import { and, desc, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import db, { schema, type Transaction } from "@/database";
import type {
  ModelCostBackfill,
  ModelCostBackfillPhase,
  ModelCostBackfillPricing,
} from "@/types/model-cost-backfill";

/**
 * Cost backfill jobs. Every write a worker makes is fenced by the lease epoch
 * it claimed with: once another worker reclaims an expired lease the epoch
 * moves on and the stale worker's writes match no row.
 */
class ModelCostBackfillModel {
  /**
   * Insert a pending backfill, or return null when the model already has an
   * active one (partial unique index on model_id while pending/running).
   */
  static async create(
    params: {
      organizationId: string;
      modelId: string;
      since: Date;
      cutoff: Date;
      pricing: ModelCostBackfillPricing;
      rowsEstimated: number;
      createdByUserId: string;
    },
    tx?: Transaction,
  ): Promise<ModelCostBackfill | null> {
    const t = schema.modelCostBackfillsTable;
    const [row] = await (tx ?? db)
      .insert(t)
      .values({ ...params, status: "pending", phase: "main" })
      .onConflictDoNothing({
        target: t.modelId,
        where: sql`status in ('pending', 'running')`,
      })
      .returning();
    return row ?? null;
  }

  /**
   * Claim the oldest active backfill whose lease is free (never claimed, or
   * expired because its worker died), bumping the epoch so any previous owner
   * is fenced out. Returns null when there is nothing to claim.
   */
  static async claimNext(params: {
    owner: string;
    leaseTtlSeconds: number;
  }): Promise<ModelCostBackfill | null> {
    const t = schema.modelCostBackfillsTable;
    const [row] = await db
      .update(t)
      .set({
        status: "running",
        leaseOwner: params.owner,
        leaseExpiresAt: sql`now() + make_interval(secs => ${params.leaseTtlSeconds})`,
        leaseEpoch: sql`${t.leaseEpoch} + 1`,
      })
      .where(
        eq(
          t.id,
          sql`(
            select id from model_cost_backfills
            where status in ('pending', 'running')
              and (lease_expires_at is null or lease_expires_at < now())
            order by created_at
            limit 1
            for update skip locked
          )`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Lock the backfill row if this worker still owns it. Taken first in each
   * batch's transaction, so a superseded worker learns it lost the lease
   * (false) before it writes a single interaction, and a reclaim cannot slip
   * in between the fence and the batch's commit.
   */
  static async lockOwned(
    params: { id: string; epoch: number },
    tx: Transaction,
  ): Promise<boolean> {
    const t = schema.modelCostBackfillsTable;
    const rows = await tx
      .select({ id: t.id })
      .from(t)
      .where(ownedBy(params))
      .for("update");
    return rows.length > 0;
  }

  /**
   * Record one batch, in its transaction: move the cursor, add to the
   * counters and renew the lease.
   */
  static async advance(
    params: {
      id: string;
      epoch: number;
      cursor: { createdAt: string; id: string };
      rowsScanned: number;
      rowsUpdated: number;
      leaseTtlSeconds: number;
    },
    tx: Transaction,
  ): Promise<boolean> {
    const t = schema.modelCostBackfillsTable;
    const rows = await tx
      .update(t)
      .set({
        cursorCreatedAt: params.cursor.createdAt,
        cursorId: params.cursor.id,
        rowsScanned: sql`${t.rowsScanned} + ${params.rowsScanned}`,
        rowsUpdated: sql`${t.rowsUpdated} + ${params.rowsUpdated}`,
        leaseExpiresAt: sql`now() + make_interval(secs => ${params.leaseTtlSeconds})`,
        consecutiveFailures: 0,
        error: null,
      })
      .where(ownedBy(params))
      .returning({ id: t.id });
    return rows.length > 0;
  }

  /** Switch to the trailing sweep, restarting the cursor at its window. */
  static async startSweep(params: {
    id: string;
    epoch: number;
  }): Promise<boolean> {
    return ModelCostBackfillModel.setOwned(params, {
      phase: "sweep" satisfies ModelCostBackfillPhase,
      cursorCreatedAt: null,
      cursorId: null,
    });
  }

  /**
   * Give the lease back before it expires (the run's time budget is spent), so
   * the next tick resumes from the cursor instead of waiting out the lease.
   */
  static async release(params: {
    id: string;
    epoch: number;
  }): Promise<boolean> {
    return ModelCostBackfillModel.setOwned(params, {
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  static async complete(params: {
    id: string;
    epoch: number;
  }): Promise<boolean> {
    return ModelCostBackfillModel.setOwned(params, {
      status: "completed",
      completedAt: sql`now()`,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /**
   * Record a failed slice and release the lease so the next tick retries from
   * the cursor. After `maxConsecutiveFailures` in a row the backfill fails.
   */
  static async recordFailure(params: {
    id: string;
    epoch: number;
    error: string;
    maxConsecutiveFailures: number;
  }): Promise<boolean> {
    const t = schema.modelCostBackfillsTable;
    const giveUp = sql`${t.consecutiveFailures} + 1 >= ${params.maxConsecutiveFailures}`;
    return ModelCostBackfillModel.setOwned(params, {
      consecutiveFailures: sql`${t.consecutiveFailures} + 1`,
      error: params.error,
      status: sql`case when ${giveUp} then 'failed' else ${t.status} end`,
      completedAt: sql`case when ${giveUp} then now() else null end`,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  static async findLatestForModel(
    modelId: string,
  ): Promise<ModelCostBackfill | null> {
    const t = schema.modelCostBackfillsTable;
    const [row] = await db
      .select()
      .from(t)
      .where(eq(t.modelId, modelId))
      .orderBy(desc(t.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** The latest backfill as the audit log records it: no lease bookkeeping. */
  static async findLatestForAudit(
    modelId: string,
  ): Promise<Record<string, unknown> | null> {
    const backfill = await ModelCostBackfillModel.findLatestForModel(modelId);
    if (!backfill) return null;
    const {
      leaseOwner: _leaseOwner,
      leaseExpiresAt: _leaseExpiresAt,
      leaseEpoch: _leaseEpoch,
      consecutiveFailures: _consecutiveFailures,
      cursorCreatedAt: _cursorCreatedAt,
      cursorId: _cursorId,
      updatedAt: _updatedAt,
      ...rest
    } = backfill;
    return rest;
  }

  private static async setOwned(
    params: { id: string; epoch: number },
    values: PgUpdateSetSource<typeof schema.modelCostBackfillsTable>,
  ): Promise<boolean> {
    const t = schema.modelCostBackfillsTable;
    const rows = await db
      .update(t)
      .set(values)
      .where(ownedBy(params))
      .returning({ id: t.id });
    return rows.length > 0;
  }
}

export default ModelCostBackfillModel;

function ownedBy(params: { id: string; epoch: number }) {
  const t = schema.modelCostBackfillsTable;
  return and(
    eq(t.id, params.id),
    eq(t.leaseEpoch, params.epoch),
    eq(t.status, "running"),
  );
}
