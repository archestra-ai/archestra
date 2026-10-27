import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import db, { schema, type Transaction } from "@/database";
import {
  type RoutingBackfill,
  type RoutingBackfillBreakdown,
  SelectRoutingBackfillSchema,
} from "@/types/auto-routing";

const t = schema.routingBackfillsTable;

/** A worker's claim on a running backfill; every write it makes is fenced by the epoch. */
export type BackfillLease = { id: string; epoch: number };

type ReserveOutcome = "reserved" | "ceiling" | "attempts" | "lost";

/**
 * Historical backfill jobs, one active (running or waiting to be scored) per
 * organization. Claims bump the lease epoch, so a worker whose lease was
 * reclaimed or whose backfill was cancelled matches no row on its next write.
 */
class RoutingBackfillModel {
  /** A new scan; null when the organization already has an active backfill. */
  static async createScan(
    params: {
      organizationId: string;
      cutoff: Date;
      windowStart: Date;
      startedBy: string | null;
    },
    tx: Transaction,
  ): Promise<RoutingBackfill | null> {
    const [row] = await tx
      .insert(t)
      .values({ ...params, status: "running", phase: "scan" })
      .onConflictDoNothing({
        target: t.organizationId,
        where: sql`status in ('running', 'scanned')`,
      })
      .returning();
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }

  /** A scored run over `scan`'s sessions, without scanning again. */
  static async createRescore(
    params: {
      scan: RoutingBackfill;
      scorerVersionId: string;
      maxSessions: number;
      maxCostUsd: number;
      startedBy: string | null;
    },
    tx: Transaction,
  ): Promise<RoutingBackfill | null> {
    const { scan } = params;
    const [row] = await tx
      .insert(t)
      .values({
        organizationId: scan.organizationId,
        status: "running",
        phase: "score",
        cutoff: scan.cutoff,
        windowStart: scan.windowStart,
        scannedAt: scan.scannedAt,
        populationSessions: scan.populationSessions,
        populationTokens: scan.populationTokens,
        breakdown: scan.breakdown,
        scorerVersionId: params.scorerVersionId,
        maxSessions: params.maxSessions,
        maxCostUsd: params.maxCostUsd.toFixed(4),
        startedBy: params.startedBy,
      })
      .onConflictDoNothing({
        target: t.organizationId,
        where: sql`status in ('running', 'scanned')`,
      })
      .returning();
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }

  /** Starts scoring a scan that waits for it. Null when it no longer waits. */
  static async startScore(params: {
    id: string;
    scorerVersionId: string;
    maxSessions: number;
    maxCostUsd: number;
    startedBy: string | null;
  }): Promise<RoutingBackfill | null> {
    const [row] = await db
      .update(t)
      .set({
        status: "running",
        phase: "score",
        scorerVersionId: params.scorerVersionId,
        maxSessions: params.maxSessions,
        maxCostUsd: params.maxCostUsd.toFixed(4),
        startedBy: params.startedBy,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(and(eq(t.id, params.id), eq(t.status, "scanned")))
      .returning();
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }

  static async findLatest(
    organizationId: string,
  ): Promise<RoutingBackfill | null> {
    const [row] = await db
      .select()
      .from(t)
      .where(eq(t.organizationId, organizationId))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(1);
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }

  /** The newest backfill whose scan finished, the sessions a re-score reuses. */
  static async findLatestScanned(
    organizationId: string,
  ): Promise<RoutingBackfill | null> {
    const [row] = await db
      .select()
      .from(t)
      .where(
        and(
          eq(t.organizationId, organizationId),
          sql`${t.scannedAt} is not null`,
        ),
      )
      .orderBy(desc(t.scannedAt), desc(t.id))
      .limit(1);
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }

  /** Retires a scan still waiting to be scored, so a newer scan can take its place. */
  static async supersedeWaiting(
    organizationId: string,
    tx: Transaction,
  ): Promise<void> {
    await tx
      .update(t)
      .set({ status: "superseded", completedAt: sql`now()` })
      .where(
        and(eq(t.organizationId, organizationId), eq(t.status, "scanned")),
      );
  }

  /**
   * Claims the oldest running backfill whose lease is free, bumping the
   * epoch so a previous owner is fenced out.
   */
  static async claimNext(params: {
    owner: string;
    leaseTtlSeconds: number;
  }): Promise<RoutingBackfill | null> {
    const [row] = await db
      .update(t)
      .set({
        leaseOwner: params.owner,
        leaseExpiresAt: sql`now() + make_interval(secs => ${params.leaseTtlSeconds})`,
        leaseEpoch: sql`${t.leaseEpoch} + 1`,
      })
      .where(
        eq(
          t.id,
          sql`(
            select id from routing_backfills
            where status = 'running'
              and (lease_expires_at is null or lease_expires_at < now())
            order by created_at
            limit 1
            for update skip locked
          )`,
        ),
      )
      .returning();
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }

  /** Whether a running backfill waits for a worker. */
  static async hasClaimable(): Promise<boolean> {
    const rows = await db
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.status, "running"),
          or(isNull(t.leaseExpiresAt), lt(t.leaseExpiresAt, sql`now()`)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Locks the backfill if this worker still owns it; taken first in every write transaction. */
  static async lockOwned(
    lease: BackfillLease,
    tx: Transaction,
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: t.id })
      .from(t)
      .where(ownedBy(lease))
      .for("update");
    return rows.length > 0;
  }

  /** Records a scan batch: moves the cursor and renews the lease. */
  static async advanceScan(
    params: {
      lease: BackfillLease;
      cursor: { profileId: string; createdAt: string; id: string };
      leaseTtlSeconds: number;
    },
    tx: Transaction,
  ): Promise<void> {
    await tx
      .update(t)
      .set({
        cursorProfileId: params.cursor.profileId,
        cursorCreatedAt: params.cursor.createdAt,
        cursorId: params.cursor.id,
        leaseExpiresAt: sql`now() + make_interval(secs => ${params.leaseTtlSeconds})`,
        consecutiveFailures: 0,
        error: null,
      })
      .where(ownedBy(params.lease));
  }

  /** The scan is complete: it waits for an admin to start scoring. */
  static async finishScan(
    params: {
      lease: BackfillLease;
      population: {
        sessions: number;
        tokens: number;
        breakdown: RoutingBackfillBreakdown;
      };
    },
    tx: Transaction,
  ): Promise<void> {
    await tx
      .update(t)
      .set({
        status: "scanned",
        scannedAt: sql`now()`,
        populationSessions: params.population.sessions,
        populationTokens: params.population.tokens,
        breakdown: params.population.breakdown,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(ownedBy(params.lease));
  }

  /**
   * Reserves `amount` of the USD ceiling for one scorer call and counts the
   * attempt. Refused once the call could take spend past the ceiling, or
   * attempts past `maxAttempts`.
   */
  static async reserve(params: {
    lease: BackfillLease;
    amount: number;
    maxAttempts: number;
  }): Promise<ReserveOutcome> {
    const amount = params.amount.toFixed(6);
    const fits = sql`${t.spentCostUsd} + ${t.reservedCostUsd} + ${amount}::numeric <= ${t.maxCostUsd}`;
    const [row] = await db
      .update(t)
      .set({
        reservedCostUsd: sql`${t.reservedCostUsd} + ${amount}::numeric`,
        attempts: sql`${t.attempts} + 1`,
      })
      .where(
        and(ownedBy(params.lease), fits, lt(t.attempts, params.maxAttempts)),
      )
      .returning({ id: t.id });
    if (row) return "reserved";
    const [current] = await db
      .select({ attempts: t.attempts })
      .from(t)
      .where(ownedBy(params.lease));
    if (!current) return "lost";
    return current.attempts >= params.maxAttempts ? "attempts" : "ceiling";
  }

  /** Swaps a reservation for what the call cost; recorded however the backfill ended meanwhile. */
  static async settle(
    params: { id: string; reserved: number; spent: number },
    tx: Transaction,
  ): Promise<void> {
    await tx
      .update(t)
      .set({
        reservedCostUsd: sql`greatest(${t.reservedCostUsd} - ${params.reserved.toFixed(6)}::numeric, 0)`,
        spentCostUsd: sql`${t.spentCostUsd} + ${params.spent.toFixed(6)}::numeric`,
      })
      .where(eq(t.id, params.id));
  }

  static async renew(
    lease: BackfillLease,
    leaseTtlSeconds: number,
  ): Promise<boolean> {
    return setOwned(lease, {
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseTtlSeconds})`,
    });
  }

  /** Gives the lease back before it expires, so the next run resumes at once. */
  static async release(lease: BackfillLease): Promise<boolean> {
    return setOwned(lease, { leaseOwner: null, leaseExpiresAt: null });
  }

  static async finish(
    lease: BackfillLease,
    outcome: { status: "done" | "superseded" | "failed"; error?: string },
    tx?: Transaction,
  ): Promise<boolean> {
    return setOwned(
      lease,
      {
        status: outcome.status,
        error: outcome.error ?? null,
        completedAt: sql`now()`,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      tx,
    );
  }

  /**
   * Records a failed run and releases the lease; after `maxConsecutiveFailures`
   * in a row the backfill fails. True when it failed.
   */
  static async recordFailure(params: {
    lease: BackfillLease;
    error: string;
    maxConsecutiveFailures: number;
  }): Promise<boolean> {
    const giveUp = sql`${t.consecutiveFailures} + 1 >= ${params.maxConsecutiveFailures}`;
    const [row] = await db
      .update(t)
      .set({
        consecutiveFailures: sql`${t.consecutiveFailures} + 1`,
        error: params.error,
        status: sql`case when ${giveUp} then 'failed' else ${t.status} end`,
        completedAt: sql`case when ${giveUp} then now() else null end`,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(ownedBy(params.lease))
      .returning({ status: t.status });
    return row?.status === "failed";
  }

  /** Cancels the organization's active backfill; null when it has none. */
  static async cancel(organizationId: string): Promise<RoutingBackfill | null> {
    const [row] = await db
      .update(t)
      .set({
        status: "cancelled",
        completedAt: sql`now()`,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(t.organizationId, organizationId),
          inArray(t.status, ["running", "scanned"]),
        ),
      )
      .returning();
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }
}

export default RoutingBackfillModel;

function ownedBy(lease: BackfillLease) {
  return and(
    eq(t.id, lease.id),
    eq(t.leaseEpoch, lease.epoch),
    eq(t.status, "running"),
  );
}

async function setOwned(
  lease: BackfillLease,
  values: PgUpdateSetSource<typeof t>,
  tx?: Transaction,
): Promise<boolean> {
  const rows = await (tx ?? db)
    .update(t)
    .set(values)
    .where(ownedBy(lease))
    .returning({ id: t.id });
  return rows.length > 0;
}
