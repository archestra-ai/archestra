/**
 * Load balancing and failover across the members of a model pool.
 *
 * A request for a pool's name is sent to the pool's members in a planned
 * order: lowest priority first, members of one priority split by weight. Each
 * member is a provider key plus the model id that provider knows the model by,
 * reached through its own transport (see `model-pool-transport.ts`). A member
 * that fails before the provider answered (see `poolFailoverReason`) is
 * benched for a while, and the request moves on to the next member. So is a
 * member whose stream sends nothing within `MODEL_POOL_FIRST_CHUNK_TIMEOUT_MS`
 * while another member is left to try. Once
 * output has reached the client, a failure goes to the client as before,
 * because it cannot accept a second answer in its place.
 */
import { createHash } from "node:crypto";
import type { SupportedProvider } from "@archestra/shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ModelPoolModel } from "@/models";
import type { ModelPool, ModelPoolMember, ModelPoolWithHealth } from "@/types";
import { poolFailoverReason } from "./llm-proxy-helpers";
import {
  canReachMember,
  type MemberTransport,
  type PoolWire,
} from "./model-pool-transport";
import { openUpstreamWithRetry } from "./upstream-connection-retry";

/**
 * How long a pool member's stream may stay silent before the request moves to
 * the next member. The last member is waited on: it has nowhere to move to.
 */
export const MODEL_POOL_FIRST_CHUNK_TIMEOUT_MS = 30_000;

/** What a request's interaction rows record about the attempt that wrote them. */
export interface UpstreamAttempt {
  providerApiKeyId?: string;
  modelPoolId?: string;
  attempt?: number;
  attemptOutcome?: "answered" | "failed_over" | "failed";
  failureReason?: string;
  /** The answering member's provider and model id, which price the attempt. */
  provider?: SupportedProvider;
  modelId?: string;
}

/** A member as a request's plan tries it. */
export interface PlannedMember {
  memberId: string;
  providerApiKeyId: string;
  provider: SupportedProvider;
  modelId: string;
}

export interface ModelPoolPlan {
  poolId: string;
  poolName: string;
  /** Members in the order they are tried. */
  members: PlannedMember[];
}

/**
 * The plan for a request whose model is a pool's name, or null when no pool
 * has that name or none of its members can answer the client's wire. The
 * session id keeps one conversation on one member while it is healthy, which
 * keeps the provider's prompt cache warm.
 */
export async function planModelPool(params: {
  organizationId: string;
  name: string;
  inbound: PoolWire;
  sessionId?: string | null;
}): Promise<ModelPoolPlan | null> {
  const pool = await ModelPoolModel.findByName({
    organizationId: params.organizationId,
    name: params.name,
  });
  if (!pool) return null;
  const reachable = pool.members.filter((member) =>
    canReachMember(params.inbound, member.provider),
  );
  if (reachable.length < pool.members.length) {
    logger.info(
      {
        poolId: pool.id,
        inbound: params.inbound,
        skipped: pool.members
          .filter((member) => !reachable.includes(member))
          .map((member) => member.provider),
      },
      "Model pool members on a wire this client cannot reach are skipped",
    );
  }
  if (reachable.length === 0) return null;
  const benches = await readBenches({ ...pool, members: reachable });
  const benchedUntil = new Map<string, number>();
  for (const [memberId, bench] of benches) {
    benchedUntil.set(memberId, bench.until);
  }
  const byId = new Map(reachable.map((member) => [member.id, member]));
  return {
    poolId: pool.id,
    poolName: pool.name,
    members: orderPoolMembers({
      members: reachable,
      benchedUntil,
      seed: params.sessionId ?? undefined,
    }).map((id) => {
      const member = byId.get(id) as ModelPoolMember;
      return {
        memberId: member.id,
        providerApiKeyId: member.providerApiKeyId,
        provider: member.provider,
        modelId: member.modelId,
      };
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
          const bench = benches.get(member.id);
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
  members: Pick<ModelPoolMember, "id" | "priority" | "weight">[];
  benchedUntil: Map<string, number>;
  seed?: string;
}): string[] {
  const available = params.members.filter(
    (member) => !params.benchedUntil.has(member.id),
  );
  const benched = params.members
    .filter((member) => params.benchedUntil.has(member.id))
    .sort(
      (a, b) =>
        (params.benchedUntil.get(a.id) ?? 0) -
        (params.benchedUntil.get(b.id) ?? 0),
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
      ordered.push(tier[index].id);
      tier.splice(index, 1);
    }
  }
  return [...ordered, ...benched.map((member) => member.id)];
}

/**
 * Opens the upstream call on the plan's members in turn. Each member gets the
 * usual connection retries first. A member that fails with a pool failover
 * reason is benched and recorded as a failed attempt, and the next member is
 * tried. The last member's failure, or any failure that is not member-local,
 * goes to the caller with `attempt` describing it.
 */
export async function openThroughModelPool<T>(params: {
  plan: ModelPoolPlan;
  attempt: UpstreamAttempt;
  /** `signal` aborts this member's upstream call when it times out. */
  transportFor: (
    member: PlannedMember,
    signal: AbortSignal,
  ) => Promise<MemberTransport>;
  open: (transport: MemberTransport) => Promise<T>;
  /** Set when `open` resolves on the first chunk of a stream. */
  firstChunkTimeoutMs?: number;
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
  for (const [index, member] of plan.members.entries()) {
    attempt.providerApiKeyId = member.providerApiKeyId;
    attempt.provider = member.provider;
    attempt.modelId = member.modelId;
    attempt.attempt = index + 1;
    attempt.failureReason = undefined;
    const isLast = index === plan.members.length - 1;
    const abort = new AbortController();
    try {
      const transport = await params.transportFor(member, abort.signal);
      const timeoutMs = isLast ? undefined : params.firstChunkTimeoutMs;
      const result = await openUpstreamWithRetry({
        open: () => withTimeout(params.open(transport), timeoutMs, abort),
        // With a sibling left, a dropped connection moves on at once rather
        // than retrying a member that may be down.
        isRetryable: isLast ? params.isRetryable : () => false,
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
        memberId: member.memberId,
        reason: failover.reason,
        retryAfterMs: failover.retryAfterMs,
      });
      if (isLast || !params.shouldContinue()) throw error;
      logger.warn(
        {
          poolId: plan.poolId,
          providerApiKeyId: member.providerApiKeyId,
          provider: member.provider,
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

/** A member that sent nothing in time. Its 408 makes it fail over. */
class MemberTimeoutError extends Error {
  readonly status = 408;
  constructor(ms: number) {
    super(`The model pool member sent nothing within ${ms / 1000} s`);
  }
}

/** `opening`, or a MemberTimeoutError and an aborted call after `ms`. */
async function withTimeout<T>(
  opening: Promise<T>,
  ms: number | undefined,
  abort: AbortController,
): Promise<T> {
  if (ms === undefined) return opening;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new MemberTimeoutError(ms);
      abort.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([opening, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

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
  memberId: string;
  reason: string;
  retryAfterMs?: number;
}): Promise<void> {
  const ms = Math.min(
    MAX_BENCH_MS,
    Math.max(1_000, params.retryAfterMs ?? DEFAULT_BENCH_MS),
  );
  try {
    await cacheManager.set(
      benchKey(params.poolId, params.memberId),
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
    pool.members.map((member) => benchKey(pool.id, member.id)),
  );
  const byMember = new Map<string, Bench>();
  for (const member of pool.members) {
    const bench = benches.get(benchKey(pool.id, member.id));
    if (bench) byMember.set(member.id, bench);
  }
  return byMember;
}

function benchKey(poolId: string, memberId: string) {
  return `${CacheKey.ModelPoolBench}-${poolId}:${memberId}` as const;
}

/** A number in [0, 1): seeded draws repeat for the same seed. */
function random(seed: string | undefined, draw: number): number {
  if (seed === undefined) return Math.random();
  const digest = createHash("sha256").update(`${seed}:${draw}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}
