import config from "@/config";
import {
  type AgentRunLimits,
  type AgentRunLimitsRequest,
  type AgentRuntime,
  type AgentRuntimeResources,
  type AgentRuntimeTier,
  ApiError,
} from "@/types";

/** Smallest to largest. */
const AGENT_RUNTIME_TIER_ORDER: readonly AgentRuntimeTier[] = ["S", "M", "L"];

/** The tier a run gets when its Agent names none. */
export const DEFAULT_AGENT_RUNTIME_TIER: AgentRuntimeTier = "M";

/**
 * CPU and memory of each tier. No CPU limit, like every run: throttling an
 * agent loop mid-turn produces confusing timeouts rather than back-pressure.
 * S fits seven runs on an 8-vCPU node, M three, L two.
 */
export const AGENT_RUNTIME_TIER_RESOURCES: Record<
  AgentRuntimeTier,
  Required<
    Pick<AgentRuntimeResources, "cpuRequest" | "memoryRequest" | "memoryLimit">
  >
> = {
  S: { cpuRequest: "1", memoryRequest: "2Gi", memoryLimit: "4Gi" },
  M: { cpuRequest: "2", memoryRequest: "4Gi", memoryLimit: "8Gi" },
  L: { cpuRequest: "3500m", memoryRequest: "12Gi", memoryLimit: "18Gi" },
};

type SizedRuntime = Pick<AgentRuntime, "resources" | "tier">;

/** The tier an Agent's runs get, or null when it sizes them with explicit resources. */
export function agentRuntimeTier(
  runtime: SizedRuntime,
): AgentRuntimeTier | null {
  if (runtime.resources) return null;
  return runtime.tier ?? DEFAULT_AGENT_RUNTIME_TIER;
}

function tierRank(tier: AgentRuntimeTier): number {
  return AGENT_RUNTIME_TIER_ORDER.indexOf(tier);
}

/** Resources a run gets: the Agent's explicit ones, else its tier's. */
export function resolveRunResources(
  runtime: SizedRuntime,
  tier: AgentRuntimeTier | null,
): AgentRuntimeResources {
  return (
    runtime.resources ??
    AGENT_RUNTIME_TIER_RESOURCES[tier ?? DEFAULT_AGENT_RUNTIME_TIER]
  );
}

/**
 * Tiers whose warm pool may serve a run, in order: the requested tier, then
 * the next larger one while it stays within the Agent's own tier, then the
 * next smaller one. A run served from a neighbour runs at that size.
 */
export function warmTierCandidates(
  tier: AgentRuntimeTier,
  max: AgentRuntimeTier,
): AgentRuntimeTier[] {
  const index = tierRank(tier);
  const candidates = [tier];
  const larger = AGENT_RUNTIME_TIER_ORDER[index + 1];
  if (larger && tierRank(larger) <= tierRank(max)) candidates.push(larger);
  const smaller = AGENT_RUNTIME_TIER_ORDER[index - 1];
  if (smaller) candidates.push(smaller);
  return candidates;
}

/**
 * The limits one run gets from the Agent's settings (its values, else the
 * deployment defaults) and a caller's request. A request above the Agent's
 * value is refused with that value named, so the caller can retry within it.
 */
export function resolveAgentRunLimits(params: {
  runtime: Pick<
    AgentRuntime,
    "resources" | "tier" | "idleTimeoutMinutes" | "ttlHours" | "maxCostUsd"
  >;
  requested?: AgentRunLimitsRequest | null;
}): AgentRunLimits {
  const { runtime } = params;
  const requested = params.requested ?? {};
  const agentTier = agentRuntimeTier(runtime);
  const idleTimeoutMinutes =
    runtime.idleTimeoutMinutes ?? config.agentRuntime.defaultIdleTimeoutMinutes;
  const maxDurationHours =
    runtime.ttlHours ?? config.agentRuntime.defaultTtlHours;
  const maxCostUsd = runtime.maxCostUsd ?? null;
  if (requested.tier !== undefined) {
    if (agentTier === null)
      throw new ApiError(
        400,
        "This Agent sizes its runs with explicit resources, so a run cannot choose a tier",
      );
    if (tierRank(requested.tier) > tierRank(agentTier))
      throw new ApiError(
        400,
        `Tier ${requested.tier} is above this Agent's tier ${agentTier}`,
      );
  }
  if (
    requested.idleTimeoutMinutes !== undefined &&
    requested.idleTimeoutMinutes > idleTimeoutMinutes
  )
    throw new ApiError(
      400,
      `An idle timeout of ${requested.idleTimeoutMinutes} minutes is above this Agent's ${idleTimeoutMinutes}`,
    );
  if (
    requested.maxDurationHours !== undefined &&
    requested.maxDurationHours > maxDurationHours
  )
    throw new ApiError(
      400,
      `A maximum duration of ${requested.maxDurationHours} hours is above this Agent's ${maxDurationHours}`,
    );
  if (
    requested.maxCostUsd !== undefined &&
    maxCostUsd !== null &&
    requested.maxCostUsd > maxCostUsd
  )
    throw new ApiError(
      400,
      `A budget of ${requested.maxCostUsd} USD is above this Agent's ${maxCostUsd}`,
    );
  return {
    tier: requested.tier ?? agentTier,
    idleTimeoutMinutes: requested.idleTimeoutMinutes ?? idleTimeoutMinutes,
    maxDurationHours: requested.maxDurationHours ?? maxDurationHours,
    maxCostUsd: requested.maxCostUsd ?? maxCostUsd,
  };
}
