import {
  orderSubagentsByLoadBalancing,
  type SubagentLoadBalancingConfig,
  TimeInMs,
} from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import CacheEntryModel from "@/models/cache-entry";

const SUBAGENT_LOAD_BALANCER_STATE_TTL_MS = 7 * TimeInMs.Day;

export interface SubagentLoadBalancerState {
  /**
   * Subagent IDs ordered from least-recently claimed (front) to
   * most-recently claimed (back).
   */
  queue: string[];
  /**
   * Monotonically increasing count of dispatches for this caller agent.
   */
  dispatchCount: number;
}

export interface PlannedSubagentCandidates {
  candidateIds: string[];
  claimedPrimaryAgentId: string | null;
}

class SubagentLoadBalancer {
  /**
   * Plans the ordered candidate subagent list for a delegation request.
   * For `round_robin`, atomically reads and advances the caller's distributed
   * queue in PostgreSQL `keyv_cache` under a transaction-scoped advisory lock
   * so concurrent requests across pods never collide on the same primary subagent.
   */
  async planCandidates(params: {
    callerAgentId: string;
    assignedAgentIds: readonly string[];
    excludedAgentIds?: ReadonlySet<string>;
    config: SubagentLoadBalancingConfig | null;
  }): Promise<PlannedSubagentCandidates> {
    const assignedList = deduplicateAgentIds(params.assignedAgentIds);
    const availableIds = assignedList.filter(
      (id) => !params.excludedAgentIds?.has(id),
    );
    if (availableIds.length === 0) {
      return { candidateIds: [], claimedPrimaryAgentId: null };
    }

    if (!params.config || !params.config.enabled) {
      return { candidateIds: availableIds, claimedPrimaryAgentId: null };
    }

    if (params.config.algorithm !== "round_robin") {
      return {
        candidateIds: orderSubagentsByLoadBalancing(
          availableIds,
          params.config,
        ),
        claimedPrimaryAgentId: null,
      };
    }

    const key = stateCacheKey(params.callerAgentId);
    return withDistributedStateLock(key, async (currentState, saveState) => {
      const reconciledQueue = reconcileQueue(
        currentState?.queue ?? [],
        assignedList,
      );
      const availableInQueueOrder = reconciledQueue.filter(
        (id) => !params.excludedAgentIds?.has(id),
      );
      const primaryId = availableInQueueOrder[0] ?? null;
      const nextQueue = primaryId
        ? moveAgentToBack(reconciledQueue, primaryId)
        : reconciledQueue;
      await saveState({
        queue: nextQueue,
        dispatchCount: (currentState?.dispatchCount ?? 0) + 1,
      });
      return {
        candidateIds: availableInQueueOrder,
        claimedPrimaryAgentId: primaryId,
      };
    });
  }

  /**
   * Restores a claimed primary subagent to the front of the distributed queue
   * when a delegation request is refused pre-launch before any runtime session starts.
   */
  async releaseUnlaunchedClaim(params: {
    callerAgentId: string;
    claimedPrimaryAgentId: string | null;
    config: SubagentLoadBalancingConfig | null;
  }): Promise<void> {
    if (
      !params.claimedPrimaryAgentId ||
      !params.config?.enabled ||
      params.config.algorithm !== "round_robin"
    ) {
      return;
    }
    const claimedId = params.claimedPrimaryAgentId;
    const key = stateCacheKey(params.callerAgentId);
    await withDistributedStateLock(key, async (currentState, saveState) => {
      if (!currentState || currentState.queue.length === 0) {
        return;
      }
      await saveState({
        queue: moveAgentToFront(currentState.queue, claimedId),
        dispatchCount: Math.max(0, currentState.dispatchCount - 1),
      });
    });
  }

  /**
   * Records that a fallback subagent actually took a run (either via pre-launch
   * fallback or post-launch runtime supervisor failover), rotating that subagent
   * to the back of the distributed queue in PostgreSQL so subsequent requests on
   * any pod will not immediately re-select it as primary.
   */
  async recordCandidateClaimed(params: {
    callerAgentId: string;
    claimedAgentId: string;
    assignedAgentIds?: readonly string[];
  }): Promise<void> {
    const key = stateCacheKey(params.callerAgentId);
    await withDistributedStateLock(key, async (currentState, saveState) => {
      const baseQueue = params.assignedAgentIds
        ? reconcileQueue(
            currentState?.queue ?? [],
            deduplicateAgentIds(params.assignedAgentIds),
          )
        : [...(currentState?.queue ?? [])];
      const nextQueue = baseQueue.includes(params.claimedAgentId)
        ? moveAgentToBack(baseQueue, params.claimedAgentId)
        : [...baseQueue, params.claimedAgentId];
      await saveState({
        queue: nextQueue,
        dispatchCount: (currentState?.dispatchCount ?? 0) + 1,
      });
    });
  }

  /**
   * Orders remaining untried fallback subagents according to the caller's live
   * distributed queue in PostgreSQL so mid-flight failovers avoid subagents
   * that were claimed by concurrent requests on other pods.
   */
  async orderRemainingCandidates(params: {
    callerAgentId?: string;
    remainingCandidateIds: readonly string[];
  }): Promise<string[]> {
    const remaining = deduplicateAgentIds(params.remainingCandidateIds);
    if (!params.callerAgentId || remaining.length <= 1) {
      return remaining;
    }
    const state = await this.getState(params.callerAgentId);
    if (!state || state.queue.length === 0) {
      return remaining;
    }
    const rankById = new Map(
      state.queue.map((agentId, index) => [agentId, index]),
    );
    return [...remaining].sort((left, right) => {
      const leftRank = rankById.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rankById.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    });
  }

  async getState(
    callerAgentId: string,
  ): Promise<SubagentLoadBalancerState | undefined> {
    const key = stateCacheKey(callerAgentId);
    return withDistributedStateLock(key, async (currentState) => currentState);
  }
}

export const subagentLoadBalancer = new SubagentLoadBalancer();

// ===== Internal helpers =====

function stateCacheKey(callerAgentId: string): AllowedCacheKey {
  return `${CacheKey.SubagentLoadBalancer}-${callerAgentId}`;
}

function deduplicateAgentIds(agentIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawId of agentIds) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function reconcileQueue(
  existingQueue: readonly string[],
  assignedAgentIds: readonly string[],
): string[] {
  const assignedSet = new Set(assignedAgentIds);
  const reconciled: string[] = [];
  const seen = new Set<string>();
  for (const id of existingQueue) {
    if (assignedSet.has(id) && !seen.has(id)) {
      seen.add(id);
      reconciled.push(id);
    }
  }
  for (const id of assignedAgentIds) {
    if (!seen.has(id)) {
      seen.add(id);
      reconciled.push(id);
    }
  }
  return reconciled;
}

function moveAgentToBack(queue: readonly string[], agentId: string): string[] {
  return [...queue.filter((id) => id !== agentId), agentId];
}

function moveAgentToFront(queue: readonly string[], agentId: string): string[] {
  if (!queue.includes(agentId)) {
    return [agentId, ...queue];
  }
  return [agentId, ...queue.filter((id) => id !== agentId)];
}

async function withDistributedStateLock<T>(
  key: AllowedCacheKey,
  fn: (
    currentState: SubagentLoadBalancerState | undefined,
    saveState: (nextState: SubagentLoadBalancerState) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  try {
    return await cacheManager.withLock(key, async (cache) => {
      const currentState = await cache.get<SubagentLoadBalancerState>(key);
      return fn(currentState, async (nextState) => {
        await cache.set(key, nextState, SUBAGENT_LOAD_BALANCER_STATE_TTL_MS);
      });
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("CacheManager: Not started")
    ) {
      throw error;
    }
    return CacheEntryModel.withLock(key, async (entries) => {
      const raw = await entries.get(`keyv:${key}`);
      let currentState: SubagentLoadBalancerState | undefined;
      if (raw !== undefined) {
        const parsed = JSON.parse(raw) as {
          value?: SubagentLoadBalancerState;
          expires?: number;
        };
        if (!parsed.expires || parsed.expires > Date.now()) {
          currentState = parsed.value;
        }
      }
      return fn(currentState, async (nextState) => {
        await entries.set(
          `keyv:${key}`,
          JSON.stringify({
            value: nextState,
            expires: Date.now() + SUBAGENT_LOAD_BALANCER_STATE_TTL_MS,
          }),
        );
      });
    });
  }
}

