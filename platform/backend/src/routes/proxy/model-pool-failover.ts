/**
 * Load balancing and failover across the members of a model pool.
 *
 * A request for a pool's name is sent to the pool's members in a planned
 * order: lowest priority first, members of one priority split by weight. Each
 * member is a provider key plus the model id that provider knows the model by,
 * reached through its own transport (see `model-pool-transport.ts`). A member
 * that fails before the provider answered (see `poolFailoverReason`) is
 * benched for a while. A transient failure is retried on another healthy
 * member of the same order, up to the pool's retry count (2 unless set), then
 * the request moves on to the next order. So is a
 * member that is silent too long while another member is left to try (see
 * `MODEL_POOL_FIRST_CHUNK_TIMEOUT_MS`), and one whose key can't be loaded. Once
 * output has reached the client, a failure goes to the client as before,
 * because it cannot accept a second answer in its place.
 */
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { SupportedProvider } from "@archestra/shared";
import {
  MODEL_POOL_RETRY_DEFAULTS,
  type ModelPoolRetrySettings,
} from "@archestra/shared/model-pool-retries";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { LlmProviderApiKeyModel, ModelPoolModel } from "@/models";
import {
  ApiError,
  type ModelPool,
  type ModelPoolMember,
  type ModelPoolWithHealth,
} from "@/types";
import { ObservedProviderUsageError } from "@/utils/observed-provider-usage-error";
import { poolFailoverReason } from "./llm-proxy-helpers";
import {
  canReachMember,
  type MemberTransport,
  type PoolWire,
} from "./model-pool-transport";

/**
 * How long a pool member's stream may stay silent before the request moves to
 * the next member, unless the pool sets its own. The last member is waited
 * on: it has nowhere to move to.
 */
export const MODEL_POOL_FIRST_CHUNK_TIMEOUT_MS = 30_000;

/**
 * The same for a non-streaming call, which only answers once the whole
 * response is ready, so it gets longer. This is the floor: a request that lets
 * the model write more gets `MODEL_POOL_MS_PER_OUTPUT_TOKEN` per token on top,
 * so a long answer isn't cut off, paid for, and asked for again elsewhere.
 */
export const MODEL_POOL_RESPONSE_TIMEOUT_MS = 180_000;

/** A slow but healthy member still writes 20 tokens a second. */
export const MODEL_POOL_MS_PER_OUTPUT_TOKEN = 50;

/**
 * The most a non-streaming member is waited on, also for a request that sets
 * no output limit.
 */
export const MODEL_POOL_MAX_RESPONSE_TIMEOUT_MS = 30 * 60_000;

/** What a request's interaction rows record about the attempt that wrote them. */
export interface UpstreamAttempt {
  /** The terminal pool failure already has an interaction and settled spend. */
  interactionRecorded?: boolean;
  modelAliases?: string[];
  billingEndpoint?: "fireworks" | "other";
  requestedModel?: string;
  providerApiKeyId?: string;
  modelPoolId?: string;
  attempt?: number;
  attemptOutcome?: "answered" | "failed_over" | "failed";
  failureReason?: string;
  /**
   * We stopped waiting on this member. Unlike a refusal, it had read the
   * prompt, and the provider bills that input whether or not we kept the answer.
   */
  cutOff?: boolean;
  /**
   * When a member after the first was tried, so its row's duration covers its
   * own attempt rather than the whole request. Unset on the first attempt.
   */
  startedAt?: number;
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
  priority: number;
  weight: number;
  /** Overrides the pool retry settings for this deployment. */
  retrySettings?: ModelPoolRetrySettings | null;
}

export interface ModelPoolPlan {
  poolId: string;
  poolName: string;
  /** Members in the order they are tried. */
  members: PlannedMember[];
  /** The pool's own stream timeout; unset keeps the default. */
  streamTimeoutMs?: number;
  /** The pool's own non-streaming timeout; unset scales the default. */
  timeoutMs?: number;
  /** The pool's own cooldown; unset keeps the default. */
  cooldownMs?: number;
  retrySettings?: ModelPoolRetrySettings | null;
  /** Explicit request retry count, taking precedence over class overrides. */
  requestNumRetries?: number;
}

/** Who is calling, as far as pool access goes. */
export interface ModelPoolCaller {
  /** Proven user identity, never the caller-supplied attribution header. */
  userId?: string;
  /** The virtual key the request authenticated with, if any. */
  virtualKeyId?: string;
  /** Provider keys the caller may already use. */
  providerApiKeyIds: string[];
  /**
   * Pools an OAuth client calling as the app was given, the only ones it may
   * use. Unset for a caller that has no list of its own.
   */
  modelPoolIds?: string[];
}

/**
 * Whether a caller may spend a pool's member keys. A virtual key, or an OAuth
 * client calling as the app, may only when the pool was added to it, whatever
 * provider keys it maps. A caller with no pools of its own (a signed-in user,
 * an identity provider's token) may when it already uses one of the members'
 * keys, since the admin who put that key in the pool chose the other members
 * as its backups.
 */
export function mayUseModelPool(params: {
  pool: Pick<ModelPool, "id" | "members" | "virtualApiKeyIds">;
  caller: ModelPoolCaller;
}): boolean {
  const { pool, caller } = params;
  if (caller.virtualKeyId) {
    return pool.virtualApiKeyIds.includes(caller.virtualKeyId);
  }
  if (caller.modelPoolIds) return caller.modelPoolIds.includes(pool.id);
  return pool.members.some((member) =>
    caller.providerApiKeyIds.includes(member.providerApiKeyId),
  );
}

/**
 * Plan a named or explicitly selected pool. Returns null when pools are off,
 * a named pool does not exist, or the caller cannot use that named pool.
 * A missing selected pool throws 404; no enabled members or any enabled member
 * incompatible with the client wire throws 400. Session affinity keeps a
 * conversation on one healthy member to reuse the provider's prompt cache.
 */
export async function planModelPool(params: {
  organizationId: string;
  name: string;
  /**
   * The pool a chat was set to, found by id: the chat sends one member's
   * model rather than the pool's name, and picking the pool let it in.
   */
  poolId?: string;
  inbound: PoolWire;
  caller: ModelPoolCaller;
  /** Set when the Unified Model API already let this caller use the pool. */
  grantedPoolId?: string;
  sessionId?: string | null;
  retryCountHeader?: string | string[];
}): Promise<ModelPoolPlan | null> {
  if (!config.llmProxy.modelPoolsEnabled) return null;
  const pool = params.poolId
    ? await ModelPoolModel.findById({
        organizationId: params.organizationId,
        id: params.poolId,
      })
    : await ModelPoolModel.findByName({
        organizationId: params.organizationId,
        name: params.name,
      });
  if (!pool) {
    if (params.poolId)
      throw new ApiError(404, "The selected model pool no longer exists");
    return null;
  }
  if (
    pool.id !== params.poolId &&
    pool.id !== params.grantedPoolId &&
    !mayUseModelPool({ pool, caller: params.caller })
  ) {
    return null;
  }
  const allEnabled = pool.members.filter((member) => member.enabled);
  if (allEnabled.length === 0)
    throw new ApiError(400, "The selected model pool has no enabled members");
  // A pool grant authorizes shared members, not somebody else's subscription.
  // Read current ownership rather than caching it with the pool definition.
  const keys = await LlmProviderApiKeyModel.findByIds([
    ...new Set(allEnabled.map((member) => member.providerApiKeyId)),
  ]);
  const usableKeys = new Set(
    keys
      .filter(
        (key) =>
          key.organizationId === params.organizationId &&
          (key.userId === null || key.userId === params.caller.userId),
      )
      .map((key) => key.id),
  );
  const enabled = allEnabled.filter((member) =>
    usableKeys.has(member.providerApiKeyId),
  );
  if (enabled.length === 0)
    throw new ApiError(
      403,
      "No model pool members are available to this caller. Personal connections can only be used by their owner.",
    );
  const reachable = enabled.filter((member) =>
    canReachMember(params.inbound, member.provider),
  );
  if (reachable.length < enabled.length) {
    throw new ApiError(
      400,
      `This model pool has members that cannot serve ${params.inbound} requests. Use a compatible request format or remove incompatible members; the pool will not be silently bypassed.`,
    );
  }
  const benches = await readBenches({ ...pool, members: reachable });
  const benchedUntil = new Map<string, number>();
  for (const [memberId, bench] of benches) {
    benchedUntil.set(memberId, bench.until);
  }
  // Keep credit-benched members for request compatibility checks. Dispatch
  // excludes them, so a temporarily exhausted compatible member yields 503.
  const byId = new Map(reachable.map((member) => [member.id, member]));
  return {
    poolId: pool.id,
    poolName: pool.name,
    streamTimeoutMs: toMs(pool.streamTimeoutSeconds),
    timeoutMs: toMs(pool.timeoutSeconds),
    cooldownMs: toMs(pool.cooldownSeconds),
    retrySettings: pool.retrySettings ?? undefined,
    requestNumRetries: parseRetryCountHeader(params.retryCountHeader),
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
        priority: member.priority,
        weight: member.weight,
        retrySettings: member.retrySettings ?? undefined,
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
 * Opens the upstream call with LiteLLM-style group reselection: retries within
 * an order, then later orders as fallbacks. Each dispatched attempt rechecks access and spend,
 * uses a fresh transport, and settles its failure before another admission.
 * A terminal failure goes to the caller with `attempt` describing it.
 */
export async function openThroughModelPool<T>(params: {
  plan: ModelPoolPlan;
  attempt: UpstreamAttempt;
  /** `signal` aborts this member's upstream call when it times out. */
  transportFor: (
    member: PlannedMember,
    signal: AbortSignal,
  ) => Promise<MemberTransport>;
  /** Resolve the member and reject hidden models before limits or provider work. */
  prepareAttempt?: (member: PlannedMember) => Promise<void>;
  /** Request-level checks run outside provider timeouts and failover handling. */
  beforeAttempt?: (member: PlannedMember) => Promise<void>;
  open: (transport: MemberTransport) => Promise<T>;
  /**
   * How long a member that isn't the last may take for `open` to resolve: the
   * first chunk of a stream, or the whole answer.
   */
  memberTimeoutMs?: number;
  isRetryable: (error: unknown) => boolean;
  shouldContinue: () => boolean;
  /** Releases backoff immediately when the downstream client leaves. */
  signal?: AbortSignal;
  onRetry?: (event: {
    attempt: number;
    delayMs: number;
    error: unknown;
  }) => void;
  /** Record and settle this failure now; finalize its routing outcome when the next choice is known. */
  prepareFailedAttempt: (
    attempt: UpstreamAttempt,
  ) => Promise<(outcome: "failed" | "failed_over") => Promise<void>>;
}): Promise<T> {
  const { plan, attempt } = params;
  attempt.modelPoolId = plan.poolId;
  let lastFailure:
    | {
        error: unknown;
        attempt: UpstreamAttempt;
        record?: (outcome: "failed" | "failed_over") => Promise<void>;
      }
    | undefined;
  const recordPreviousFailure = async (
    outcome: "failed" | "failed_over",
  ): Promise<boolean> => {
    if (!lastFailure?.record) return false;
    try {
      await lastFailure.record(outcome);
      return true;
    } catch (recordError) {
      logger.error(
        { err: recordError, poolId: plan.poolId },
        "Failed to record a failed model pool attempt",
      );
      return false;
    }
  };
  let hiddenError: ApiError | undefined;
  let attempted = 0;
  let creditCoolingDown = false;
  // Retries reselect within the group, then use explicit order fallbacks.
  // A pool without settings uses the defaults.
  const selection = new PoolRetrySelection(plan);
  for (;;) {
    const member = await selection.next();
    if (!member) break;
    if (params.signal?.aborted || !params.shouldContinue()) {
      if (lastFailure) break;
      throw new DOMException("The proxy client disconnected", "AbortError");
    }
    // Another request may have exhausted this member after this plan was built.
    const bench = await cacheManager.get<Bench>(
      benchKey(plan.poolId, member.memberId, "credit"),
    );
    if (
      bench &&
      bench.until > Date.now() &&
      bench.reason.startsWith("credit_exhausted")
    ) {
      creditCoolingDown = true;
      continue;
    }
    attempt.providerApiKeyId = member.providerApiKeyId;
    attempt.provider = member.provider;
    attempt.modelId = member.modelId;
    attempt.attempt = attempted + 1;
    attempt.failureReason = undefined;
    attempt.interactionRecorded = undefined;
    attempt.cutOff = undefined;
    attempt.startedAt = attempted > 0 ? Date.now() : undefined;
    try {
      await params.prepareAttempt?.(member);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.internalCode !== "model_hidden"
      ) {
        await recordPreviousFailure("failed_over");
        throw error;
      }
      hiddenError = error;
      selection.skip(member);
      continue;
    }
    try {
      await params.beforeAttempt?.(member);
    } catch (error) {
      // A visible sibling's admission refusal keeps the preceding failover
      // outcome. Only skipped hidden members leave that failure terminal.
      await recordPreviousFailure("failed_over");
      throw error;
    }
    attempted++;
    // A fresh weighted retry can select the original tail early, so only
    // waive the timeout when no other eligible selection can follow.
    const isLast = !(await selection.canTryAnother(member));
    const abort = new AbortController();
    try {
      const transport = await params
        .transportFor(member, abort.signal)
        .catch((error: unknown) => {
          throw new MemberUnavailableError(error);
        });
      const timeoutMs = isLast ? undefined : params.memberTimeoutMs;
      const result = await withTimeout(
        params.open(transport),
        timeoutMs,
        abort,
      );
      await recordPreviousFailure("failed_over");
      attempt.attemptOutcome = "answered";
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.internalCode === "model_hidden") {
        hiddenError = error;
        selection.skip(member);
        attempted--;
        continue;
      }
      await recordPreviousFailure("failed_over");
      lastFailure = undefined;
      const failover =
        error instanceof ObservedProviderUsageError
          ? undefined
          : error instanceof MemberUnavailableError
            ? { reason: "key_unavailable", retryAfterMs: undefined }
            : poolFailoverReason(error, member.provider);
      attempt.attemptOutcome = "failed";
      if (error instanceof MemberTimeoutError) attempt.cutOff = true;
      // An error that doesn't fail over still gets a reason; its message is in
      // the row's response.
      attempt.failureReason = failover?.reason ?? "error";
      if (!failover) throw error;
      const delayMs = selection.failed({
        member,
        failover,
        connectionRetryable: params.isRetryable(error),
      });
      // Keep the existing cooldown policy. Only a sole deployment gets its
      // bounded recovery attempts before being benched: there is no sibling
      // to select. A group never resurrects a cooling member to fill a budget.
      if (delayMs === undefined || plan.members.length > 1)
        await benchMember({
          poolId: plan.poolId,
          memberId: member.memberId,
          reason: failover.reason,
          retryAfterMs: failover.retryAfterMs,
          cooldownMs: plan.cooldownMs,
        });
      if (!params.shouldContinue()) {
        throw error instanceof MemberUnavailableError ? error.cause : error;
      }
      if (delayMs === undefined) {
        logger.warn(
          {
            poolId: plan.poolId,
            providerApiKeyId: member.providerApiKeyId,
            provider: member.provider,
            attempt: attempted,
            reason: failover.reason,
          },
          "Model pool member failed before answering; trying the next member",
        );
      }
      lastFailure = {
        error: error instanceof MemberUnavailableError ? error.cause : error,
        attempt: { ...attempt },
      };
      try {
        lastFailure.record = await params.prepareFailedAttempt(
          lastFailure.attempt,
        );
      } catch (recordError) {
        logger.error(
          { err: recordError, poolId: plan.poolId },
          "Failed to prepare a failed model pool attempt",
        );
      }
      // A remaining budget alone is not a retry: benching may have removed
      // the final eligible member. Return its failure without a pointless wait.
      if (delayMs !== undefined && (await selection.hasRetryCandidate())) {
        params.onRetry?.({
          attempt: selection.retryCount,
          delayMs,
          error,
        });
        try {
          await sleep(delayMs, undefined, { signal: params.signal });
        } catch (error) {
          if (params.signal?.aborted) break;
          throw error;
        }
      }
    }
  }
  if (lastFailure) {
    Object.assign(attempt, lastFailure.attempt);
    attempt.interactionRecorded = await recordPreviousFailure("failed");
    throw lastFailure.error;
  }
  if (hiddenError) throw hiddenError;
  // Selection skips benched members, so a pool whose members all ran out of
  // credit reaches here without trying any of them.
  if (
    creditCoolingDown ||
    (attempted === 0 && (await everyMemberOutOfCredit(plan)))
  )
    throw new ApiError(
      503,
      "All compatible model pool members are cooling down after credit exhaustion. Try again after their cooldown expires.",
    );
  throw new ApiError(503, "No healthy model pool members are available");
}

// === Internal helpers ===

/** Request overrides are pool-only, bounded, and never forwarded upstream. */
function parseRetryCountHeader(value: string | string[] | undefined) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:[0-9]|10)$/.test(value)) {
    throw new ApiError(
      400,
      "x-archestra-num-retries must be an integer from 0 to 10",
    );
  }
  return Number(value);
}

/** The member's settings over the pool's; blank ones use the defaults. */
function resolveRetrySettings(
  plan: ModelPoolPlan,
  member: PlannedMember,
): ModelPoolRetrySettings {
  return {
    ...plan.retrySettings,
    ...member.retrySettings,
    retryPolicy: {
      ...plan.retrySettings?.retryPolicy,
      ...member.retrySettings?.retryPolicy,
    },
  };
}

/** Fail over for permanent failures; retry only transient pre-output failures. */
function retryDelayMs(params: {
  settings: ModelPoolRetrySettings;
  requestNumRetries?: number;
  retryCount: number;
  failover: { reason: string; status?: number; retryAfterMs?: number };
  connectionRetryable: boolean;
}): number | undefined {
  const { settings, failover, retryCount } = params;
  const limit = retryLimit(
    settings,
    params.requestNumRetries,
    failover,
    params.connectionRetryable,
  );
  if (limit === undefined) return undefined;
  if (retryCount >= limit) return undefined;
  const max = settings.maxDelayMs ?? MODEL_POOL_RETRY_DEFAULTS.maxDelayMs;
  const retryAfter = failover.retryAfterMs;
  // A reset hours away should fail over, never turn into a busy retry loop.
  if (
    retryAfter !== undefined &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0
  ) {
    return retryAfter <= max ? Math.ceil(retryAfter) : undefined;
  }
  const exponential = Math.min(
    max,
    (settings.initialDelayMs ?? MODEL_POOL_RETRY_DEFAULTS.initialDelayMs) *
      2 ** retryCount,
  );
  // Downward jitter matches common SDK semantics and stays within the cap.
  return Math.max(1, Math.ceil(exponential * (0.75 + Math.random() * 0.25)));
}

/** One count per group/order hop, chosen by its first failed deployment. */
function retryLimit(
  settings: ModelPoolRetrySettings,
  requestNumRetries: number | undefined,
  failover: { reason: string },
  connectionRetryable: boolean,
): number | undefined {
  const errorClass = retryErrorClass(failover, connectionRetryable);
  if (!errorClass) return undefined;
  return (
    requestNumRetries ??
    settings.retryPolicy?.[errorClass] ??
    settings.numRetries ??
    MODEL_POOL_RETRY_DEFAULTS.numRetries
  );
}

function retryErrorClass(
  failover: { reason: string },
  connectionRetryable: boolean,
) {
  return failover.reason.startsWith("unreachable")
    ? connectionRetryable
      ? "connectionError"
      : undefined
    : failover.reason.startsWith("timeout")
      ? "timeoutError"
      : failover.reason.startsWith("rate_limited")
        ? "rateLimitError"
        : failover.reason.startsWith("server_error")
          ? "internalServerError"
          : undefined;
}

/**
 * LiteLLM's group/order selection shape: a shared retry budget, fresh healthy
 * weighted selection, then later orders as separate fallback hops. Archestra's
 * cooldown and retryable-error policies remain its own.
 */
class PoolRetrySelection {
  retryCount = 0;
  private readonly skipped = new Set<string>();
  private readonly fallbackOrders: number[];
  private order: number | undefined;
  private settings: ModelPoolRetrySettings | undefined;
  private hopFinished = false;
  private initial = true;

  constructor(private readonly plan: ModelPoolPlan) {
    this.fallbackOrders = [
      ...new Set(plan.members.map((member) => member.priority)),
    ]
      .sort((a, b) => a - b)
      .slice(1);
  }

  skip(member: PlannedMember) {
    this.skipped.add(member.memberId);
  }

  async next(): Promise<PlannedMember | undefined> {
    for (;;) {
      if (this.hopFinished && !this.advanceOrder()) return undefined;
      const benches = await readBenches({
        id: this.plan.poolId,
        members: this.plan.members.map((member) => ({ id: member.memberId })),
      });
      const eligible = this.plan.members.filter(
        (member) =>
          !this.skipped.has(member.memberId) &&
          (this.order === undefined || member.priority === this.order) &&
          (benches.get(member.memberId)?.until ?? 0) <= Date.now(),
      );
      if (eligible.length === 0) {
        if (!this.advanceOrder()) return undefined;
        continue;
      }
      // Retain the initial affinity/weighted plan; retries and order fallbacks
      // draw again, always among the lowest healthy order.
      if (this.initial) {
        this.initial = false;
        const priority = Math.min(...eligible.map((member) => member.priority));
        return eligible.find((member) => member.priority === priority);
      }
      const [id] = orderPoolMembers({
        members: eligible.map((member) => ({ ...member, id: member.memberId })),
        benchedUntil: new Map(),
      });
      return eligible.find((member) => member.memberId === id);
    }
  }

  /** Inspect the next selection without advancing its order or retry budget. */
  async hasRetryCandidate(): Promise<boolean> {
    const benches = await readBenches({
      id: this.plan.poolId,
      members: this.plan.members.map((member) => ({ id: member.memberId })),
    });
    return this.plan.members.some(
      (member) =>
        !this.skipped.has(member.memberId) &&
        (benches.get(member.memberId)?.until ?? 0) <= Date.now() &&
        (this.order === undefined ||
          member.priority === this.order ||
          this.fallbackOrders.includes(member.priority)),
    );
  }

  /** A weighted retry can reach any member, including the old plan's tail. */
  async canTryAnother(member: PlannedMember): Promise<boolean> {
    const benches = await readBenches({
      id: this.plan.poolId,
      members: this.plan.members.map((candidate) => ({
        id: candidate.memberId,
      })),
    });
    const timeoutRetries =
      this.settings?.numRetries ??
      retryLimit(
        resolveRetrySettings(this.plan, member),
        this.plan.requestNumRetries,
        { reason: "timeout" },
        false,
      ) ??
      0;
    return this.plan.members.some(
      (candidate) =>
        candidate.memberId !== member.memberId &&
        !this.skipped.has(candidate.memberId) &&
        (benches.get(candidate.memberId)?.until ?? 0) <= Date.now() &&
        ((this.retryCount < timeoutRetries &&
          (this.order === undefined || candidate.priority === this.order)) ||
          this.fallbackOrders.includes(candidate.priority)),
    );
  }

  failed(params: {
    member: PlannedMember;
    failover: { reason: string; retryAfterMs?: number };
    connectionRetryable: boolean;
  }): number | undefined {
    if (!this.settings) {
      const settings = resolveRetrySettings(this.plan, params.member);
      this.settings = {
        ...settings,
        numRetries:
          retryLimit(
            settings,
            this.plan.requestNumRetries,
            params.failover,
            params.connectionRetryable,
          ) ?? 0,
        retryPolicy: undefined,
      };
    }
    const delay = retryDelayMs({
      ...params,
      settings: this.settings,
      retryCount: this.retryCount,
    });
    if (delay === undefined) this.hopFinished = true;
    else this.retryCount++;
    return delay;
  }

  private advanceOrder(): boolean {
    this.order = this.fallbackOrders.shift();
    this.settings = undefined;
    this.retryCount = 0;
    this.hopFinished = false;
    this.initial = false;
    return this.order !== undefined;
  }
}

/** A member that didn't answer in time. Its 408 makes it fail over. */
class MemberTimeoutError extends Error {
  readonly status = 408;
  constructor(ms: number) {
    super(`The model pool member didn't answer within ${ms / 1000} s`);
  }
}

/**
 * A member whose client couldn't be built: its key was deleted, or its secret
 * can't be read. Another member's key may still work.
 */
class MemberUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The model pool member's provider key can't be used", { cause });
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
/**
 * A Retry-After is honored up to this, or the pool's cooldown when longer; a
 * longer wait just moves on.
 */
const MAX_BENCH_MS = 60_000;
/** Billing failures need a top-up; retry at most once an hour by default. */
const CREDIT_BENCH_MS = 60 * 60_000;

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
  /**
   * The pool's cooldown: the shortest bench, which a longer Retry-After can
   * extend. Without one, a Retry-After sets the bench, shorter or longer.
   */
  cooldownMs?: number;
}): Promise<void> {
  const cooldownMs = params.cooldownMs ?? DEFAULT_BENCH_MS;
  // Reuse the pool cooldown override (including shorter recovery probes).
  const ms = params.reason.startsWith("credit_exhausted")
    ? (params.cooldownMs ?? CREDIT_BENCH_MS)
    : Math.min(
        Math.max(MAX_BENCH_MS, cooldownMs),
        Math.max(params.cooldownMs ?? 1_000, params.retryAfterMs ?? cooldownMs),
      );
  try {
    await cacheManager.set(
      // Separate slots prevent an already in-flight transient failure from
      // overwriting a credit exclusion, including across server replicas.
      benchKey(
        params.poolId,
        params.memberId,
        params.reason.startsWith("credit_exhausted") ? "credit" : undefined,
      ),
      { until: Date.now() + ms, reason: params.reason } satisfies Bench,
      ms,
    );
  } catch (error) {
    // Benching only steers later requests; this one moves on regardless.
    logger.warn({ err: error, ...params }, "Failed to bench model pool member");
  }
}

async function readBenches(pool: {
  id: string;
  members: Pick<ModelPoolMember, "id">[];
}): Promise<Map<string, Bench>> {
  const benches = await cacheManager.getMany<Bench>(
    pool.members.flatMap((member) => [
      benchKey(pool.id, member.id),
      benchKey(pool.id, member.id, "credit"),
    ]),
  );
  const byMember = new Map<string, Bench>();
  for (const member of pool.members) {
    const credit = benches.get(benchKey(pool.id, member.id, "credit"));
    const bench =
      credit && credit.until > Date.now()
        ? credit
        : benches.get(benchKey(pool.id, member.id));
    if (bench) byMember.set(member.id, bench);
  }
  return byMember;
}

async function everyMemberOutOfCredit(plan: ModelPoolPlan) {
  const benches = await readBenches({
    id: plan.poolId,
    members: plan.members.map((member) => ({ id: member.memberId })),
  });
  return plan.members.every((member) => {
    const bench = benches.get(member.memberId);
    return (
      bench !== undefined &&
      bench.until > Date.now() &&
      bench.reason.startsWith("credit_exhausted")
    );
  });
}

function toMs(seconds: number | null): number | undefined {
  return seconds === null ? undefined : seconds * 1000;
}

function benchKey(poolId: string, memberId: string, kind?: "credit") {
  return `${CacheKey.ModelPoolBench}-${poolId}:${memberId}${kind ? ":credit" : ""}` as const;
}

/** A number in [0, 1): seeded draws repeat for the same seed. */
function random(seed: string | undefined, draw: number): number {
  if (seed === undefined) return Math.random();
  const digest = createHash("sha256").update(`${seed}:${draw}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}
