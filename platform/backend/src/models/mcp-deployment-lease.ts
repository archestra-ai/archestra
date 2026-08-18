import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import logger from "@/logging";

/** Thrown by {@link McpDeploymentLeaseModel.withLease} when another replica holds the lease. */
export class ClusterLeaseHeldError extends Error {
  constructor(scope: string, key: string) {
    super(`the "${scope}" lease for ${key} is held by another replica`);
    this.name = "ClusterLeaseHeldError";
  }
}

/**
 * Thrown when a holder can no longer prove it owns an acquired lease.
 * @public — exported so model tests can assert the lease-guard failure contract.
 */
export class ClusterLeaseLostError extends Error {
  constructor(scope: string, key: string, options?: ErrorOptions) {
    super(`the "${scope}" lease for ${key} was lost`, options);
    this.name = "ClusterLeaseLostError";
  }
}

export type ClusterLeaseGuard = {
  signal: AbortSignal;
  assertOwned: () => Promise<void>;
  runFencedMutation: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  throwIfLost: () => void;
};

/**
 * How long an unrenewed lease stays valid. Long enough that a paused event
 * loop or a slow renewal write cannot cost a live holder its lease; short
 * enough that a crashed replica's lease clears well before an administrator
 * gives up and escalates past the API.
 */
const LEASE_TTL_SECONDS = 60;

/**
 * Renewal cadence — a quarter of the TTL, so a holder survives two missed
 * renewals before its lease becomes claimable.
 */
const LEASE_RENEW_INTERVAL_MS = 15_000;

/** Never let a contender wait indefinitely behind a fenced K8s mutation. */
const LEASE_ROW_LOCK_TIMEOUT_MS = 250;

/**
 * Cluster-wide mutual exclusion over `mcp_deployment_leases` rows, for
 * actions that must run once at a time per physical resource across every
 * replica — an in-process single-flight only coordinates one Node process.
 *
 * Advisory locks were considered and rejected: session-level locks are
 * unsound over a connection pool (release lands on a different connection
 * and the lock survives until that session dies), and transaction-level
 * locks would pin a transaction open for the whole operation. A TTL row
 * needs neither: a crashed holder simply stops renewing, and the database
 * clock arbitrates expiry for every replica alike.
 */
class McpDeploymentLeaseModel {
  /**
   * Run `fn` while holding the {scope, key} lease, renewing it in the
   * background and releasing it afterwards. Throws {@link ClusterLeaseHeldError}
   * without calling `fn` when another live holder has it.
   */
  static async withLease<T>(
    params: { scope: string; key: string },
    fn: (guard: ClusterLeaseGuard) => Promise<T>,
  ): Promise<T> {
    const holder = randomUUID();
    const acquired = await McpDeploymentLeaseModel.tryAcquire({
      ...params,
      holder,
    });
    if (!acquired) {
      throw new ClusterLeaseHeldError(params.scope, params.key);
    }

    const controller = new AbortController();
    const markLost = (cause?: unknown) => {
      if (!controller.signal.aborted) {
        controller.abort(
          new ClusterLeaseLostError(params.scope, params.key, { cause }),
        );
      }
    };
    const throwIfLost = () => {
      if (!controller.signal.aborted) return;
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new ClusterLeaseLostError(params.scope, params.key);
    };
    const assertOwned = async () => {
      throwIfLost();
      try {
        if (!(await McpDeploymentLeaseModel.renew({ ...params, holder }))) {
          markLost();
          throwIfLost();
        }
      } catch (error) {
        if (error instanceof ClusterLeaseLostError) throw error;
        markLost(error);
        throwIfLost();
      }
    };
    let fencedMutationsInFlight = 0;
    const runFencedMutation = async <T>(
      fn: (tx: Transaction) => Promise<T>,
    ): Promise<T> => {
      throwIfLost();
      fencedMutationsInFlight++;
      try {
        return await McpDeploymentLeaseModel.runFencedMutation(
          { ...params, holder },
          fn,
        );
      } catch (error) {
        if (error instanceof ClusterLeaseLostError) markLost(error);
        throw error;
      } finally {
        fencedMutationsInFlight--;
      }
    };

    // Recursive timeout, not setInterval: a slow renewal can never overlap a
    // later one and obscure which result owns the lease.
    let stopped = false;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRenewal = () => {
      renewalTimer = setTimeout(async () => {
        // A fenced mutation owns this row's FOR UPDATE lock and extends expiry
        // when it commits. Trying to renew through that same lock only blocks
        // until statement_timeout and falsely declares the live holder lost.
        if (fencedMutationsInFlight > 0) {
          if (!stopped) scheduleRenewal();
          return;
        }
        try {
          await assertOwned();
        } catch (error) {
          logger.error(
            { err: error, ...params },
            "Lost a deployment lease while its operation was still running",
          );
          return;
        }
        if (!stopped) scheduleRenewal();
      }, LEASE_RENEW_INTERVAL_MS);
      renewalTimer.unref?.();
    };
    scheduleRenewal();

    try {
      const guard = {
        signal: controller.signal,
        assertOwned,
        runFencedMutation,
        throwIfLost,
      };
      const result = await fn(guard);
      // Never report a successful operation from a holder that expired or was
      // replaced while its final await was in flight.
      await assertOwned();
      return result;
    } finally {
      stopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      // Work that outlives the callback (for example a readiness wait whose
      // caller timed out) must never keep using a guard after its lease ends.
      markLost();
      await McpDeploymentLeaseModel.release({ ...params, holder }).catch(
        (error) => {
          // Expiry reclaims an unreleased lease; failing the operation over
          // a failed cleanup would punish work that already finished.
          logger.warn(
            { err: error, ...params },
            "Failed to release a deployment lease; it will expire instead",
          );
        },
      );
    }
  }

  /**
   * Wait until no live holder owns a lease. An expired row is available even
   * before another caller replaces it. Used by demand after its usage stamp:
   * if hibernation already owns the gate, demand waits for that transition and
   * then re-reads Kubernetes; if hibernation starts later, its final usage read
   * observes the stamp and refuses to scale down.
   */
  static async waitUntilAvailable(params: {
    scope: string;
    key: string;
    timeoutMs: number;
    pollIntervalMs?: number;
  }): Promise<void> {
    const deadline = Date.now() + params.timeoutMs;
    const pollIntervalMs = params.pollIntervalMs ?? 50;
    while (await McpDeploymentLeaseModel.isHeld(params)) {
      if (Date.now() >= deadline) {
        throw new ClusterLeaseHeldError(params.scope, params.key);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /** Wait for a lease and acquire it without leaving a check/acquire gap. */
  static async withLeaseWhenAvailable<T>(
    params: { scope: string; key: string; timeoutMs: number },
    fn: (guard: ClusterLeaseGuard) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + params.timeoutMs;
    while (true) {
      try {
        return await McpDeploymentLeaseModel.withLease(params, fn);
      } catch (error) {
        if (!(error instanceof ClusterLeaseHeldError)) throw error;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw error;
        await McpDeploymentLeaseModel.waitUntilAvailable({
          ...params,
          timeoutMs: remainingMs,
        });
      }
    }
  }

  /**
   * Insert the lease row, or take over an existing one whose `expires_at`
   * has passed. Returns false — and writes nothing — while another holder's
   * lease is still live. Single statement, so two replicas racing here are
   * serialized by the row's primary key.
   */
  private static async tryAcquire(params: {
    scope: string;
    key: string;
    holder: string;
  }): Promise<boolean> {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('lock_timeout', ${`${LEASE_ROW_LOCK_TIMEOUT_MS}ms`}, true)`,
        );
        const rows = await tx
          .insert(schema.mcpDeploymentLeasesTable)
          .values({
            scope: params.scope,
            key: params.key,
            holder: params.holder,
            expiresAt: sql`clock_timestamp() + make_interval(secs => ${LEASE_TTL_SECONDS})`,
          })
          .onConflictDoUpdate({
            target: [
              schema.mcpDeploymentLeasesTable.scope,
              schema.mcpDeploymentLeasesTable.key,
            ],
            set: {
              holder: params.holder,
              acquiredAt: sql`clock_timestamp()`,
              expiresAt: sql`clock_timestamp() + make_interval(secs => ${LEASE_TTL_SECONDS})`,
            },
            setWhere: sql`${schema.mcpDeploymentLeasesTable.expiresAt} < clock_timestamp()`,
          })
          .returning({ holder: schema.mcpDeploymentLeasesTable.holder });
        return rows.length > 0;
      });
    } catch (error) {
      if (getPostgresErrorCode(error) === "55P03") return false;
      throw error;
    }
  }

  private static async isHeld(params: {
    scope: string;
    key: string;
  }): Promise<boolean> {
    const rows = await db
      .select({ key: schema.mcpDeploymentLeasesTable.key })
      .from(schema.mcpDeploymentLeasesTable)
      .where(
        and(
          eq(schema.mcpDeploymentLeasesTable.scope, params.scope),
          eq(schema.mcpDeploymentLeasesTable.key, params.key),
          sql`${schema.mcpDeploymentLeasesTable.expiresAt} >= clock_timestamp()`,
        ),
      )
      .limit(1);
    return rows.length === 1;
  }

  private static async renew(params: {
    scope: string;
    key: string;
    holder: string;
  }): Promise<boolean> {
    const rows = await db
      .update(schema.mcpDeploymentLeasesTable)
      .set({
        expiresAt: sql`clock_timestamp() + make_interval(secs => ${LEASE_TTL_SECONDS})`,
      })
      .where(
        and(
          eq(schema.mcpDeploymentLeasesTable.scope, params.scope),
          eq(schema.mcpDeploymentLeasesTable.key, params.key),
          eq(schema.mcpDeploymentLeasesTable.holder, params.holder),
          sql`${schema.mcpDeploymentLeasesTable.expiresAt} >= clock_timestamp()`,
        ),
      )
      .returning({ holder: schema.mcpDeploymentLeasesTable.holder });
    return rows.length === 1;
  }

  /**
   * Hold the lease row lock across one external mutation. Expiry alone cannot
   * fence a paused holder between its final ownership check and a Kubernetes
   * write: a successor can acquire without changing the target object. The
   * row lock makes those two events mutually exclusive while keeping the
   * transaction bounded to the final read/write rather than the whole
   * lifecycle operation.
   */
  private static async runFencedMutation<T>(
    params: { scope: string; key: string; holder: string },
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ holder: schema.mcpDeploymentLeasesTable.holder })
        .from(schema.mcpDeploymentLeasesTable)
        .where(
          and(
            eq(schema.mcpDeploymentLeasesTable.scope, params.scope),
            eq(schema.mcpDeploymentLeasesTable.key, params.key),
            eq(schema.mcpDeploymentLeasesTable.holder, params.holder),
            sql`${schema.mcpDeploymentLeasesTable.expiresAt} >= clock_timestamp()`,
          ),
        )
        .for("update");
      if (!owned) {
        throw new ClusterLeaseLostError(params.scope, params.key);
      }

      const result = await fn(tx);
      await tx
        .update(schema.mcpDeploymentLeasesTable)
        .set({
          expiresAt: sql`clock_timestamp() + make_interval(secs => ${LEASE_TTL_SECONDS})`,
        })
        .where(
          and(
            eq(schema.mcpDeploymentLeasesTable.scope, params.scope),
            eq(schema.mcpDeploymentLeasesTable.key, params.key),
            eq(schema.mcpDeploymentLeasesTable.holder, params.holder),
          ),
        );
      return result;
    });
  }

  private static async release(params: {
    scope: string;
    key: string;
    holder: string;
  }): Promise<void> {
    await db
      .delete(schema.mcpDeploymentLeasesTable)
      .where(
        and(
          eq(schema.mcpDeploymentLeasesTable.scope, params.scope),
          eq(schema.mcpDeploymentLeasesTable.key, params.key),
          eq(schema.mcpDeploymentLeasesTable.holder, params.holder),
        ),
      );
  }
}

function getPostgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? getPostgresErrorCode(error.cause) : undefined;
}

export default McpDeploymentLeaseModel;
