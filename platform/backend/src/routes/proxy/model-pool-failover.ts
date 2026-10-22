/**
 * Load balancing and failover across the members of a model pool.
 *
 * A request whose resolved provider key is a member of the pool for its model
 * is sent to the pool's members in a planned order: lowest priority first,
 * members of one priority split by weight. A member that fails before the
 * provider answered (see `poolFailoverReason`) is benched for a while, and the
 * request moves on to the next member. Once output has reached the client, a
 * failure goes to the client as before, because it cannot accept a second
 * answer in its place.
 */
import { createHash } from "node:crypto";
import type { SupportedProvider } from "@archestra/shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ModelPoolModel } from "@/models";
import type { ModelPool, ModelPoolMember, ModelPoolWithHealth } from "@/types";
import { poolFailoverReason } from "./llm-proxy-helpers";
import { openUpstreamWithRetry } from "./upstream-connection-retry";

/** What a request's interaction rows record about the attempt that wrote them. */
export interface UpstreamAttempt {
  providerApiKeyId?: string;
  modelPoolId?: string;
  attempt?: number;
  attemptOutcome?: "answered" | "failed_over" | "failed";
  failureReason?: string;
}

export interface ModelPoolPlan {
  poolId: string;
  poolName: string;
  /** Member provider keys in the order they are tried. */
  memberKeyIds: string[];
}

/**
 * The plan for a request, or null when its key is in no pool for its model.
 * The session id keeps one conversation on one member while it is healthy,
 * which keeps the provider's prompt cache warm.
 */
export async function planModelPool(params: {
  organizationId: string;
  provider: SupportedProvider;
  modelId: string;
  providerApiKeyId: string;
  sessionId?: string | null;
}): Promise<ModelPoolPlan | null> {
  const pool = await ModelPoolModel.findForMemberKey(params);
  if (!pool || pool.members.length === 0) return null;
  const benches = await readBenches(pool);
  const benchedUntil = new Map<string, number>();
  for (const [providerApiKeyId, bench] of benches) {
    benchedUntil.set(providerApiKeyId, bench.until);
  }
  return {
    poolId: pool.id,
    poolName: pool.name,
    memberKeyIds: orderPoolMembers({
      members: pool.members,
      benchedUntil,
      seed: params.sessionId ?? undefined,
    }),
  };
}

/** Each pool with when its benched members come back, for the admin page. */
export async function withMemberHealth(
  pools: ModelPool[],
): Promise<ModelPoolWithHealth[]> {
  return Promise.all(
    pools.map(async (pool) => {
      const benches = await readBenches(pool);
      return {
        ...pool,
        members: pool.members.map((member) => {
          const bench = benches.get(member.providerApiKeyId);
          return {
            ...member,
            benchedUntil: bench ? new Date(bench.until).toISOString() : null,
            benchReason: bench?.reason ?? null,
          };
        }),
      };
    }),
  );
}

/**
 * Members by ascending priority; within one priority, a weighted draw without
 * replacement. Benched members go last, soonest back first, so a request
 * still has somewhere to go when every member is benched. A seed makes the
 * draw deterministic.
 */
export function orderPoolMembers(params: {
  members: Pick<ModelPoolMember, "providerApiKeyId" | "priority" | "weight">[];
  benchedUntil: Map<string, number>;
  seed?: string;
}): string[] {
  const available = params.members.filter(
    (member) => !params.benchedUntil.has(member.providerApiKeyId),
  );
  const benched = params.members
    .filter((member) => params.benchedUntil.has(member.providerApiKeyId))
    .sort(
      (a, b) =>
        (params.benchedUntil.get(a.providerApiKeyId) ?? 0) -
        (params.benchedUntil.get(b.providerApiKeyId) ?? 0),
    );
  const priorities = [...new Set(available.map((m) => m.priority))].sort(
    (a, b) => a - b,
  );
  const ordered: string[] = [];
  let draw = 0;
  for (const priority of priorities) {
    const tier = available.filter((member) => member.priority === priority);
    while (tier.length > 0) {
      const total = tier.reduce((sum, member) => sum + member.weight, 0);
      let point = random(params.seed, draw++) * total;
      let index = 0;
      while (index < tier.length - 1 && point >= tier[index].weight) {
        point -= tier[index].weight;
        index++;
      }
      ordered.push(tier[index].providerApiKeyId);
      tier.splice(index, 1);
    }
  }
  return [...ordered, ...benched.map((member) => member.providerApiKeyId)];
}

/**
 * Opens the upstream call on the plan's members in turn. Each member gets the
 * usual connection retries first. A member that fails with a pool failover
 * reason is benched and recorded as a failed attempt, and the next member is
 * tried. The last member's failure, or any failure that is not member-local,
 * goes to the caller with `attempt` describing it.
 */
export async function openThroughModelPool<TClient, T>(params: {
  plan: ModelPoolPlan;
  attempt: UpstreamAttempt;
  clientFor: (providerApiKeyId: string) => Promise<TClient>;
  open: (client: TClient) => Promise<T>;
  isRetryable: (error: unknown) => boolean;
  shouldContinue: () => boolean;
  onRetry?: (event: {
    attempt: number;
    delayMs: number;
    error: unknown;
  }) => void;
  recordFailedAttempt: (attempt: UpstreamAttempt) => Promise<void>;
}): Promise<T> {
  const { plan, attempt } = params;
  attempt.modelPoolId = plan.poolId;
  for (const [index, providerApiKeyId] of plan.memberKeyIds.entries()) {
    attempt.providerApiKeyId = providerApiKeyId;
    attempt.attempt = index + 1;
    attempt.failureReason = undefined;
    try {
      const client = await params.clientFor(providerApiKeyId);
      const result = await openUpstreamWithRetry({
        open: () => params.open(client),
        isRetryable: params.isRetryable,
        shouldContinue: params.shouldContinue,
        onRetry: params.onRetry,
      });
      attempt.attemptOutcome = "answered";
      return result;
    } catch (error) {
      const failover = poolFailoverReason(error);
      attempt.attemptOutcome = "failed";
      attempt.failureReason = failover?.reason;
      if (!failover) throw error;
      await benchMember({
        poolId: plan.poolId,
        providerApiKeyId,
        reason: failover.reason,
        retryAfterMs: failover.retryAfterMs,
      });
      const isLast = index === plan.memberKeyIds.length - 1;
      if (isLast || !params.shouldContinue()) throw error;
      logger.warn(
        {
          poolId: plan.poolId,
          providerApiKeyId,
          attempt: index + 1,
          reason: failover.reason,
        },
        "Model pool member failed before answering; trying the next member",
      );
      try {
        await params.recordFailedAttempt({
          ...attempt,
          attemptOutcome: "failed_over",
        });
      } catch (recordError) {
        logger.error(
          { err: recordError, poolId: plan.poolId },
          "Failed to record a failed model pool attempt",
        );
      }
    }
  }
  // Unreachable: the plan has at least one member and the last one returns or throws.
  throw new Error("Model pool plan has no members");
}

// === Internal helpers ===

/** How long a failed member sits out without a usable Retry-After. */
const DEFAULT_BENCH_MS = 30_000;
/** A member never sits out longer than this; a longer wait just moves on. */
const MAX_BENCH_MS = 60_000;

/** A benched member: when it comes back, and the failure that benched it. */
interface Bench {
  until: number;
  reason: string;
}

async function benchMember(params: {
  poolId: string;
  providerApiKeyId: string;
  reason: string;
  retryAfterMs?: number;
}): Promise<void> {
  const ms = Math.min(
    MAX_BENCH_MS,
    Math.max(1_000, params.retryAfterMs ?? DEFAULT_BENCH_MS),
  );
  try {
    await cacheManager.set(
      benchKey(params.poolId, params.providerApiKeyId),
      { until: Date.now() + ms, reason: params.reason } satisfies Bench,
      ms,
    );
  } catch (error) {
    // Benching only steers later requests; this one moves on regardless.
    logger.warn({ err: error, ...params }, "Failed to bench model pool member");
  }
}

async function readBenches(
  pool: Pick<ModelPool, "id" | "members">,
): Promise<Map<string, Bench>> {
  const benches = await cacheManager.getMany<Bench>(
    pool.members.map((member) => benchKey(pool.id, member.providerApiKeyId)),
  );
  const byMember = new Map<string, Bench>();
  for (const member of pool.members) {
    const bench = benches.get(benchKey(pool.id, member.providerApiKeyId));
    if (bench) byMember.set(member.providerApiKeyId, bench);
  }
  return byMember;
}

function benchKey(poolId: string, providerApiKeyId: string) {
  return `${CacheKey.ModelPoolBench}-${poolId}:${providerApiKeyId}` as const;
}

/** A number in [0, 1): seeded draws repeat for the same seed. */
function random(seed: string | undefined, draw: number): number {
  if (seed === undefined) return Math.random();
  const digest = createHash("sha256").update(`${seed}:${draw}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}
