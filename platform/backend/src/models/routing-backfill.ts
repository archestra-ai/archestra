import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import db, { schema, type Transaction } from "@/database";
import {
  type RoutingBackfill,
  type RoutingBackfillBreakdown,
  type RoutingBackfillPhase,
  SelectRoutingBackfillSchema,
} from "@/types/auto-routing";

const t = schema.routingBackfillsTable;

/** A worker's claim on a running backfill; every write it makes is fenced by the epoch. */
export type BackfillLease = { id: string; epoch: number };

/**
 * A scan publication: the finished scan whose population fits read. A
 * re-score copies a scan's bounds but publishes nothing, and was created
 * after that scan finished, so only a scan was created before its
 * `scannedAt`.
 */
export type ScanFrame = Pick<
  RoutingBackfill,
  "id" | "windowStart" | "cutoff"
> & { scannedAt: Date };

type ReserveOutcome =
  | { kind: "reserved"; amount: number }
  | { kind: "ceiling" | "attempts" | "lost" };

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

  /**
   * A scored run over the sessions of scan `scanId`, without scanning again.
   * Null unless that scan is still the organization's latest and no backfill
   * is active.
   */
  static async createRescore(
    params: {
      scanId: string;
      organizationId: string;
      scorerVersionId: string;
      scorerApiKeyId: string | null;
      maxSessions: number;
      maxCostUsd: number;
      startedBy: string | null;
    },
    tx: Transaction,
  ): Promise<RoutingBackfill | null> {
    const scan = await RoutingBackfillModel.findLatestScanned(
      params.organizationId,
      tx,
    );
    if (scan?.id !== params.scanId) return null;
    const [row] = await tx
      .insert(t)
      .values({
        organizationId: scan.organizationId,
        status: "running",
        phase: "score",
        cutoff: scan.cutoff,
        windowStart: scan.windowStart,
        // Copied in SQL: a Date would truncate it to milliseconds.
        scannedAt: sql`(select scanned_at from routing_backfills where id = ${scan.id})`,
        populationSessions: scan.populationSessions,
        populationTokens: scan.populationTokens,
        breakdown: scan.breakdown,
        scorerVersionId: params.scorerVersionId,
        scorerApiKeyId: params.scorerApiKeyId,
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
    organizationId: string;
    scorerVersionId: string;
    scorerApiKeyId: string;
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
        scorerApiKeyId: params.scorerApiKeyId,
        maxSessions: params.maxSessions,
        maxCostUsd: params.maxCostUsd.toFixed(4),
        startedBy: params.startedBy,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(t.id, params.id),
          eq(t.organizationId, params.organizationId),
          eq(t.status, "scanned"),
        ),
      )
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

  /** The organization's newest backfill other than `backfill`. */
  static async findLatestBefore(
    backfill: RoutingBackfill,
    tx: Transaction,
  ): Promise<RoutingBackfill | null> {
    const [row] = await tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.organizationId, backfill.organizationId),
          ne(t.id, backfill.id),
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(1);
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }

  /** The newest scan publication, the sessions a re-score reuses. */
  static async findLatestScanned(
    organizationId: string,
    tx?: Transaction,
  ): Promise<RoutingBackfill | null> {
    const [row] = await (tx ?? db)
      .select()
      .from(t)
      .where(and(eq(t.organizationId, organizationId), isScanPublication))
      .orderBy(desc(t.scannedAt), desc(t.id))
      .limit(1);
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }

  /** The newest `limit` scan publications whose window ends after `since`, newest first. */
  static async findScanFrames(params: {
    organizationId: string;
    since: Date;
    limit: number;
  }): Promise<ScanFrame[]> {
    const rows = await db
      .select(frameColumns)
      .from(t)
      .where(
        and(
          eq(t.organizationId, params.organizationId),
          isScanPublication,
          gt(t.cutoff, params.since),
        ),
      )
      .orderBy(desc(t.scannedAt), desc(t.id))
      .limit(params.limit);
    return rows.flatMap(toScanFrame);
  }

  /**
   * The generation the newest scoring run that asked a fit of `routerId`
   * raised it to, whichever backfill the organization shows; null when none
   * did.
   */
  static async findRequestedFitGeneration(
    organizationId: string,
    routerId: string,
  ): Promise<number | null> {
    const requested = sql<string>`${t.fitGenerations} ->> ${routerId}`;
    const [row] = await db
      .select({ generation: requested })
      .from(t)
      .where(
        and(
          eq(t.organizationId, organizationId),
          sql`${requested} is not null`,
        ),
      )
      .orderBy(desc(t.completedAt), desc(t.id))
      .limit(1);
    return row ? Number(row.generation) : null;
  }

  /** The organization's scan publication `id`, if it still exists. */
  static async findScanFrame(
    organizationId: string,
    id: string,
  ): Promise<ScanFrame | null> {
    const rows = await db
      .select(frameColumns)
      .from(t)
      .where(
        and(
          eq(t.organizationId, organizationId),
          eq(t.id, id),
          isScanPublication,
        ),
      );
    return rows.flatMap(toScanFrame)[0] ?? null;
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
        // A previous owner's unsettled calls may have been paid.
        spentCostUsd: sql`${t.spentCostUsd} + ${t.reservedCostUsd}`,
        reservedCostUsd: "0",
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
   * Reserves one scorer call's share of the USD ceiling — `minAmount` or the
   * most a call has cost so far, whichever is higher — and counts the
   * attempt. Refused once the call could take spend past the ceiling, or
   * attempts past `maxAttempts`.
   */
  static async reserve(
    params: {
      lease: BackfillLease;
      minAmount: number;
      maxAttempts: number;
    },
    tx?: Transaction,
  ): Promise<ReserveOutcome> {
    const amount = sql`greatest(${t.callCostUsd}, ${params.minAmount.toFixed(6)}::numeric)`;
    const [row] = await (tx ?? db)
      .update(t)
      .set({
        reservedCostUsd: sql`${t.reservedCostUsd} + ${amount}`,
        attempts: sql`${t.attempts} + 1`,
      })
      .where(
        and(
          ownedBy(params.lease),
          sql`${t.spentCostUsd} + ${t.reservedCostUsd} + ${amount} <= ${t.maxCostUsd}`,
          lt(t.attempts, params.maxAttempts),
        ),
      )
      .returning({ amount: sql<string>`${amount}` });
    if (row) return { kind: "reserved", amount: Number(row.amount) };
    const [current] = await (tx ?? db)
      .select({ attempts: t.attempts })
      .from(t)
      .where(ownedBy(params.lease));
    if (!current) return { kind: "lost" };
    return {
      kind: current.attempts >= params.maxAttempts ? "attempts" : "ceiling",
    };
  }

  /**
   * Swaps a reservation for what the call cost, raising later calls'
   * reservations to it; recorded however the backfill ended meanwhile. A
   * claim since the reservation already booked it as spent and holds only
   * its successor's reservations, so a call from an older lease adds just
   * what it cost beyond its reservation.
   */
  static async settle(
    params: { lease: BackfillLease; reserved: number; spent: number },
    tx: Transaction,
  ): Promise<void> {
    const spent = sql`${params.spent.toFixed(6)}::numeric`;
    const reserved = sql`${params.reserved.toFixed(6)}::numeric`;
    const current = sql`${t.leaseEpoch} = ${params.lease.epoch}`;
    await tx
      .update(t)
      .set({
        reservedCostUsd: sql`case when ${current} then greatest(${t.reservedCostUsd} - ${reserved}, 0) else ${t.reservedCostUsd} end`,
        spentCostUsd: sql`${t.spentCostUsd} + case when ${current} then ${spent} else greatest(${spent} - ${reserved}, 0) end`,
        callCostUsd: sql`greatest(${t.callCostUsd}, ${spent})`,
      })
      .where(eq(t.id, params.lease.id));
  }

  /**
   * Raises a reservation by what its call cost beyond it, so a claim that
   * books the reservation before the call settled books what it cost.
   */
  static async raiseReservation(params: {
    lease: BackfillLease;
    by: number;
  }): Promise<void> {
    const by = sql`${params.by.toFixed(6)}::numeric`;
    const current = sql`${t.leaseEpoch} = ${params.lease.epoch}`;
    await db
      .update(t)
      .set({
        reservedCostUsd: sql`${t.reservedCostUsd} + case when ${current} then ${by} else 0 end`,
        spentCostUsd: sql`${t.spentCostUsd} + case when ${current} then 0 else ${by} end`,
      })
      .where(eq(t.id, params.lease.id));
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
    outcome:
      | {
          status: "done";
          error?: string;
          fitGenerations: Record<string, number>;
        }
      | { status: "superseded" | "failed"; error?: string },
    tx?: Transaction,
  ): Promise<boolean> {
    return setOwned(
      lease,
      {
        status: outcome.status,
        error: outcome.error ?? null,
        ...(outcome.status === "done" && {
          fitGenerations: outcome.fitGenerations,
        }),
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

  /**
   * Cancels the organization's backfill `id` while it is active in `phase`;
   * null when it is not. The phase keeps a stop meant for a scan from
   * cancelling the scoring that took over its row.
   */
  static async cancel(
    organizationId: string,
    id: string,
    phase: RoutingBackfillPhase,
  ): Promise<RoutingBackfill | null> {
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
          eq(t.id, id),
          eq(t.phase, phase),
          inArray(t.status, ["running", "scanned"]),
        ),
      )
      .returning();
    return row ? SelectRoutingBackfillSchema.parse(row) : null;
  }

  /**
   * The organization's newest backfills with who started them, newest first.
   * A scan retired by a newer one before anyone scored it is left out.
   */
  static async findHistory(
    organizationId: string,
    limit: number,
  ): Promise<(RoutingBackfill & { startedByName: string | null })[]> {
    const rows = await db
      .select({ backfill: t, startedByName: schema.usersTable.name })
      .from(t)
      .leftJoin(schema.usersTable, eq(schema.usersTable.id, t.startedBy))
      .where(
        and(
          eq(t.organizationId, organizationId),
          sql`not (${t.phase} = 'scan' and ${t.status} = 'superseded')`,
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit);
    return rows.map((row) => ({
      ...SelectRoutingBackfillSchema.parse(row.backfill),
      startedByName: row.startedByName,
    }));
  }
}

export default RoutingBackfillModel;

const isScanPublication = sql`${t.scannedAt} is not null and ${t.createdAt} < ${t.scannedAt}`;

const frameColumns = {
  id: t.id,
  windowStart: t.windowStart,
  cutoff: t.cutoff,
  scannedAt: t.scannedAt,
};

function toScanFrame({
  scannedAt,
  ...row
}: {
  id: string;
  windowStart: Date;
  cutoff: Date;
  scannedAt: Date | null;
}): ScanFrame[] {
  return scannedAt ? [{ ...row, scannedAt }] : [];
}

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
