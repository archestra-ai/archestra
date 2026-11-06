import { z } from "zod";

export const SUBAGENT_LOAD_BALANCING_ALGORITHMS = [
  "round_robin",
  "weighted",
  "random",
] as const;

export const SubagentLoadBalancingAlgorithmSchema = z.enum(
  SUBAGENT_LOAD_BALANCING_ALGORITHMS,
);
export type SubagentLoadBalancingAlgorithm = z.infer<
  typeof SubagentLoadBalancingAlgorithmSchema
>;

export const SUBAGENT_LOAD_BALANCING_MIN_WEIGHT = 1;
export const SUBAGENT_LOAD_BALANCING_MAX_WEIGHT = 1000;
export const SUBAGENT_LOAD_BALANCING_MAX_RETRIES = 3;

export const SubagentLoadBalancingConfigSchema = z.object({
  /** Whether load balancing is enabled for subagents assigned to this agent or MCP gateway. */
  enabled: z.boolean().default(false),
  /** How incoming requests are distributed among assigned subagents when enabled. */
  algorithm: SubagentLoadBalancingAlgorithmSchema.default("round_robin"),
  /**
   * Per-subagent weights (1..1000) keyed by subagent UUID, used when
   * `algorithm` is `"weighted"`. Subagents omitted from this map default to 1.
   */
  weights: z
    .record(
      z.string().uuid(),
      z
        .number()
        .int()
        .min(SUBAGENT_LOAD_BALANCING_MIN_WEIGHT)
        .max(SUBAGENT_LOAD_BALANCING_MAX_WEIGHT),
    )
    .optional(),
  /** Number of retries on the same subagent after a retriable failure (0..3). */
  retries: z
    .number()
    .int()
    .min(0)
    .max(SUBAGENT_LOAD_BALANCING_MAX_RETRIES)
    .default(1),
  /** Whether failed subagent requests fall back to alternative assigned subagents. */
  fallbackEnabled: z.boolean().default(true),
});

export type SubagentLoadBalancingConfig = z.infer<
  typeof SubagentLoadBalancingConfigSchema
>;

/**
 * Stored representation for reads so rows saved by older or newer versions
 * still parse cleanly.
 */
export const StoredSubagentLoadBalancingConfigSchema = z.object({
  enabled: z.boolean().catch(false),
  algorithm: SubagentLoadBalancingAlgorithmSchema.catch("round_robin"),
  weights: z
    .record(z.string(), z.number().int().min(1).max(1000))
    .optional()
    .catch(undefined),
  retries: z
    .number()
    .int()
    .min(0)
    .max(SUBAGENT_LOAD_BALANCING_MAX_RETRIES)
    .catch(SUBAGENT_LOAD_BALANCING_MAX_RETRIES),
  fallbackEnabled: z.boolean().catch(true),
});

export function normalizeSubagentLoadBalancingConfig(
  config: unknown,
): SubagentLoadBalancingConfig | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  return StoredSubagentLoadBalancingConfigSchema.parse(config);
}

export interface SubagentLoadBalancerScopeInput {
  userId?: string | null;
  serviceAccountId?: string | null;
  teamId?: string | null;
  organizationId?: string | null;
}

export const DEFAULT_SUBAGENT_LOAD_BALANCER_SCOPE_KEY = "default";

/**
 * Resolves the load-balancer partition key for a request in priority order:
 * user -> service account -> team -> organization -> "default".
 */
export function resolveSubagentLoadBalancerScopeKey(
  scope?: SubagentLoadBalancerScopeInput | string | null,
): string {
  if (typeof scope === "string") {
    const trimmed = scope.trim();
    return trimmed.length > 0
      ? trimmed
      : DEFAULT_SUBAGENT_LOAD_BALANCER_SCOPE_KEY;
  }
  if (!scope) {
    return DEFAULT_SUBAGENT_LOAD_BALANCER_SCOPE_KEY;
  }
  const userId = scope.userId?.trim();
  if (userId) {
    return `user:${userId}`;
  }
  const serviceAccountId = scope.serviceAccountId?.trim();
  if (serviceAccountId) {
    return `service_account:${serviceAccountId}`;
  }
  const teamId = scope.teamId?.trim();
  if (teamId) {
    return `team:${teamId}`;
  }
  const organizationId = scope.organizationId?.trim();
  if (organizationId) {
    return `org:${organizationId}`;
  }
  return DEFAULT_SUBAGENT_LOAD_BALANCER_SCOPE_KEY;
}

export function normalizeSubagentWeight(weight?: number | null): number {
  if (typeof weight !== "number" || !Number.isFinite(weight)) {
    return SUBAGENT_LOAD_BALANCING_MIN_WEIGHT;
  }
  return Math.max(
    SUBAGENT_LOAD_BALANCING_MIN_WEIGHT,
    Math.min(SUBAGENT_LOAD_BALANCING_MAX_WEIGHT, Math.trunc(weight)),
  );
}

export function hashSubagentLoadBalancerSeed(input: string | number): number {
  const text = String(input);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function createSeededSubagentRandom(
  seedInput: string | number,
): () => number {
  let state = (hashSubagentLoadBalancerSeed(seedInput) || 0x6d2b79f5) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Performs one Smooth Weighted Round-Robin (Nginx SWRR) selection step over
 * `availableIds`, breaking ties by `tieBreakOrder` (e.g. LRU queue order), and
 * returns the chosen candidate along with updated `currentWeights` and ordered
 * fallback candidates.
 */
export function stepSmoothWeightedRoundRobin(params: {
  availableIds: readonly string[];
  weights?: Record<string, number> | null;
  currentWeights?: Record<string, number> | null;
  tieBreakOrder?: readonly string[];
}): {
  chosenId: string | null;
  orderedIds: string[];
  nextCurrentWeights: Record<string, number>;
} {
  const { availableIds, weights, currentWeights, tieBreakOrder } = params;
  if (availableIds.length === 0) {
    return {
      chosenId: null,
      orderedIds: [],
      nextCurrentWeights: { ...(currentWeights ?? {}) },
    };
  }
  if (availableIds.length === 1) {
    const only = availableIds[0] ?? null;
    return {
      chosenId: only,
      orderedIds: only ? [only] : [],
      nextCurrentWeights: { ...(currentWeights ?? {}) },
    };
  }

  const rankById = new Map<string, number>();
  const rankSource =
    tieBreakOrder && tieBreakOrder.length > 0 ? tieBreakOrder : availableIds;
  rankSource.forEach((id, idx) => {
    if (!rankById.has(id)) {
      rankById.set(id, idx);
    }
  });
  availableIds.forEach((id, idx) => {
    if (!rankById.has(id)) {
      rankById.set(id, rankSource.length + idx);
    }
  });

  const orderedAvailable = [...availableIds].sort(
    (a, b) => (rankById.get(a) ?? 0) - (rankById.get(b) ?? 0),
  );

  const nextCurrentWeights: Record<string, number> = {
    ...(currentWeights ?? {}),
  };
  let totalWeight = 0;
  let chosenId = orderedAvailable[0] ?? null;
  let maxCurrent = Number.NEGATIVE_INFINITY;

  for (const id of orderedAvailable) {
    const w = normalizeSubagentWeight(weights?.[id]);
    const updated = (nextCurrentWeights[id] ?? 0) + w;
    nextCurrentWeights[id] = updated;
    totalWeight += w;
    if (updated > maxCurrent) {
      maxCurrent = updated;
      chosenId = id;
    }
  }

  if (chosenId !== null) {
    nextCurrentWeights[chosenId] =
      (nextCurrentWeights[chosenId] ?? 0) - totalWeight;
  }

  // Build fallback tail by continuing SWRR without replacement on a scratch copy
  const orderedIds: string[] = chosenId ? [chosenId] : [];
  const remaining = orderedAvailable.filter((id) => id !== chosenId);
  const scratchWeights = { ...nextCurrentWeights };
  while (remaining.length > 0) {
    let remTotal = 0;
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const id = remaining[i];
      if (!id) continue;
      const w = normalizeSubagentWeight(weights?.[id]);
      const score = (scratchWeights[id] ?? 0) + w;
      scratchWeights[id] = score;
      remTotal += w;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const nextId = remaining[bestIdx];
    if (nextId) {
      scratchWeights[nextId] = (scratchWeights[nextId] ?? 0) - remTotal;
      orderedIds.push(nextId);
    }
    remaining.splice(bestIdx, 1);
  }

  return {
    chosenId,
    orderedIds,
    nextCurrentWeights,
  };
}

/**
 * Deterministic stateless Smooth Weighted Round-Robin ordering for a given
 * `seed` (step index) and optional `scopeKey`.
 */
export function orderSubagentsBySmoothWeightedRoundRobin(
  agentIds: readonly string[],
  weights?: Record<string, number> | null,
  seed = 0,
  scopeKey?: string | null,
): string[] {
  const n = agentIds.length;
  if (n <= 1) return [...agentIds];
  const totalWeight = agentIds.reduce(
    (sum, id) => sum + normalizeSubagentWeight(weights?.[id]),
    0,
  );
  const normalizedScope =
    scopeKey &&
    scopeKey.trim().length > 0 &&
    scopeKey !== DEFAULT_SUBAGENT_LOAD_BALANCER_SCOPE_KEY
      ? scopeKey.trim()
      : null;
  const scopeOffset = normalizedScope
    ? hashSubagentLoadBalancerSeed(normalizedScope) % totalWeight
    : 0;
  const steps =
    (((Math.trunc(seed) + scopeOffset) % totalWeight) + totalWeight) %
    totalWeight;

  let currentWeights: Record<string, number> = {};
  let tieBreakQueue = [...agentIds];
  let lastOrdered = [...agentIds];
  for (let s = 0; s <= steps; s++) {
    const stepped = stepSmoothWeightedRoundRobin({
      availableIds: agentIds,
      weights,
      currentWeights,
      tieBreakOrder: tieBreakQueue,
    });
    currentWeights = stepped.nextCurrentWeights;
    lastOrdered = stepped.orderedIds;
    if (stepped.chosenId) {
      tieBreakQueue = [
        ...tieBreakQueue.filter((id) => id !== stepped.chosenId),
        stepped.chosenId,
      ];
    }
  }
  return lastOrdered;
}

/**
 * Orders assigned subagent IDs according to the load-balancing policy.
 * - Disabled: preserves assignment order.
 * - `round_robin`: rotates primary selection at `seed mod N` and rotates
 *   fallback order across full rounds so no single neighbor absorbs all failovers.
 * - `random`: uniform random permutation (seeded by `(scopeKey, seed)` when `seed` is provided without custom `random`).
 * - `weighted`: Smooth Weighted Round-Robin when `seed` is provided without custom `random`,
 *   or weighted sampling without replacement using `random`.
 */
export function orderSubagentsByLoadBalancing(
  agentIds: readonly string[],
  config:
    | (Pick<SubagentLoadBalancingConfig, "enabled" | "algorithm" | "weights"> &
        Partial<SubagentLoadBalancingConfig>)
    | null
    | undefined,
  options?: {
    seed?: number;
    scopeKey?: string | null;
    random?: () => number;
  },
): string[] {
  const n = agentIds.length;
  if (n <= 1) return [...agentIds];
  if (!config || !config.enabled) {
    return [...agentIds];
  }
  const hasExplicitRandom = typeof options?.random === "function";
  const hasSeed = options?.seed !== undefined;
  const normalizedScope = resolveSubagentLoadBalancerScopeKey(
    options?.scopeKey,
  );
  const random =
    options?.random ??
    (hasSeed
      ? createSeededSubagentRandom(`${normalizedScope}:${options?.seed}`)
      : Math.random);

  if (config.algorithm === "random") {
    const result = [...agentIds];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  if (config.algorithm === "weighted") {
    if (hasSeed && !hasExplicitRandom) {
      return orderSubagentsBySmoothWeightedRoundRobin(
        agentIds,
        config.weights,
        options?.seed ?? 0,
        normalizedScope,
      );
    }
    const remaining = agentIds.map((id) => ({
      id,
      weight: normalizeSubagentWeight(config.weights?.[id]),
    }));
    const ordered: string[] = [];
    while (remaining.length > 0) {
      const totalWeight = remaining.reduce((sum, item) => sum + item.weight, 0);
      let threshold = random() * totalWeight;
      let chosenIndex = remaining.length - 1;
      for (let i = 0; i < remaining.length; i++) {
        threshold -= remaining[i].weight;
        if (threshold < 0) {
          chosenIndex = i;
          break;
        }
      }
      ordered.push(remaining[chosenIndex].id);
      remaining.splice(chosenIndex, 1);
    }
    return ordered;
  }
  const scopeOffset =
    normalizedScope !== DEFAULT_SUBAGENT_LOAD_BALANCER_SCOPE_KEY && !hasSeed
      ? hashSubagentLoadBalancerSeed(normalizedScope)
      : 0;
  const rawSeed = hasSeed
    ? Math.trunc(options.seed ?? 0)
    : scopeOffset > 0
      ? scopeOffset
      : Math.floor(random() * n);
  const start = ((rawSeed % n) + n) % n;
  const tail = [...agentIds.slice(start + 1), ...agentIds.slice(0, start)];
  if (tail.length <= 1) {
    return [agentIds[start], ...tail];
  }
  const round = Math.floor(Math.max(0, rawSeed) / n);
  const tailShift = round % tail.length;
  return [
    agentIds[start],
    ...tail.slice(tailShift),
    ...tail.slice(0, tailShift),
  ];
}
