import { z } from "zod";

export const SUBAGENT_LOAD_BALANCING_ALGORITHMS = [
  "round_robin",
  "weighted",
  "random",
  "ordered",
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
export const SUBAGENT_LOAD_BALANCING_MAX_FALLBACKS = 100;

export const SubagentLoadBalancingConfigSchema = z.object({
  /** Whether load balancing is enabled for subagents assigned to this MCP gateway. */
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
  /**
   * Maximum number of alternative subagents to try after a failure.
   * Null or omitted tries all remaining assigned subagents.
   */
  maxFallbacks: z
    .number()
    .int()
    .min(0)
    .max(SUBAGENT_LOAD_BALANCING_MAX_FALLBACKS)
    .nullable()
    .optional(),
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
    .transform((value) =>
      Math.max(0, Math.min(SUBAGENT_LOAD_BALANCING_MAX_RETRIES, value)),
    )
    .catch(1),
  fallbackEnabled: z.boolean().catch(true),
  maxFallbacks: z
    .number()
    .int()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .catch(null),
});

const gatewayRoundRobinCounters = new Map<string, number>();

/**
 * Returns the next round-robin counter for `gatewayId` (0, 1, 2, ...).
 */
export function nextGatewayRoundRobinSeed(gatewayId: string): number {
  const current = gatewayRoundRobinCounters.get(gatewayId) ?? 0;
  gatewayRoundRobinCounters.set(gatewayId, (current + 1) % 1_000_000_000);
  return current;
}

export function resetGatewayRoundRobinSeeds(): void {
  gatewayRoundRobinCounters.clear();
}

/**
 * Orders assigned subagent IDs according to the gateway's load-balancing policy.
 * - Disabled or `ordered`: preserves assignment order.
 * - `round_robin`: rotates the list starting at `seed mod N`.
 * - `random`: uniform random permutation.
 * - `weighted`: weighted sampling without replacement using configured weights (default 1).
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
    random?: () => number;
  },
): string[] {
  const n = agentIds.length;
  if (n <= 1) return [...agentIds];
  if (!config || !config.enabled || config.algorithm === "ordered") {
    return [...agentIds];
  }
  const random = options?.random ?? Math.random;
  if (config.algorithm === "round_robin") {
    const seed =
      options?.seed !== undefined ? options.seed : Math.floor(random() * n);
    const start = ((seed % n) + n) % n;
    return [...agentIds.slice(start), ...agentIds.slice(0, start)];
  }
  if (config.algorithm === "random") {
    const result = [...agentIds];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  const remaining = agentIds.map((id) => ({
    id,
    weight: Math.max(1, Math.min(1000, Math.trunc(config.weights?.[id] ?? 1))),
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
