import {
  type AgentRuntimeTierSize,
  resolveAgentRuntimeTiers,
} from "@archestra/shared";
import config from "@/config";
import OrganizationModel from "@/models/organization";
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

/** Each tier's size in one organization. */
type AgentRuntimeTierSizes = Record<AgentRuntimeTier, AgentRuntimeTierSize>;

/**
 * The organization's tiers in effect: its administrator's overrides
 * (Settings > Agents) over the code defaults in @archestra/shared.
 */
export async function organizationAgentRuntimeTiers(
  organizationId: string,
): Promise<AgentRuntimeTierSizes> {
  const organization = await OrganizationModel.getById(organizationId);
  return resolveAgentRuntimeTiers(organization?.agentRuntimeTiers);
}

/** The container resources of a tier's size. */
export function tierResources(
  size: AgentRuntimeTierSize,
): AgentRuntimeResources {
  return {
    cpuRequest: size.cpuRequest,
    ...(size.cpuLimit ? { cpuLimit: size.cpuLimit } : {}),
    memoryRequest: size.memoryRequest,
    memoryLimit: size.memoryLimit,
  };
}

type SizedRuntime = Pick<AgentRuntime, "tier" | "maxTier">;

/** The tier an Agent's runs get by default. */
export function agentRuntimeTier(runtime: SizedRuntime): AgentRuntimeTier {
  return runtime.tier ?? DEFAULT_AGENT_RUNTIME_TIER;
}

/**
 * The largest tier a caller may ask for: the Agent's `maxTier`, never below
 * its own tier.
 */
export function agentRuntimeMaxTier(runtime: SizedRuntime): AgentRuntimeTier {
  const tier = agentRuntimeTier(runtime);
  const max = runtime.maxTier ?? tier;
  return tierRank(max) > tierRank(tier) ? max : tier;
}

function tierRank(tier: AgentRuntimeTier): number {
  return AGENT_RUNTIME_TIER_ORDER.indexOf(tier);
}

/** The resources a run gets: its tier's size in the organization. */
export function resolveRunResources(
  tier: AgentRuntimeTier | null,
  tiers: AgentRuntimeTierSizes,
): AgentRuntimeResources {
  return tierResources(tiers[tier ?? DEFAULT_AGENT_RUNTIME_TIER]);
}

/**
 * Tiers whose warm pool may serve a run, in order: the requested tier, then
 * the next larger one while it stays within the Agent's largest tier. Never a
 * smaller one: a run sized below what it asked for can run out of memory. A
 * run served from the larger pool runs at that size.
 */
export function warmTierCandidates(
  tier: AgentRuntimeTier,
  max: AgentRuntimeTier,
): AgentRuntimeTier[] {
  const larger = AGENT_RUNTIME_TIER_ORDER[tierRank(tier) + 1];
  return larger && tierRank(larger) <= tierRank(max) ? [tier, larger] : [tier];
}

/**
 * Spares a warm pool keeps: the tier's own count when its administrator or
 * the defaults set one (L keeps none by default), else the deployment's
 * `ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE`. None while warm pools are off.
 */
export function warmPoolReplicas(
  tiers: AgentRuntimeTierSizes,
  tier: AgentRuntimeTier,
): number {
  const deployment = config.agentRuntime.warmPoolSize;
  if (deployment === 0) return deployment;
  return tiers[tier].warmPoolSize ?? deployment;
}

/**
 * The limits one run gets from the Agent's settings (its values, else the
 * deployment defaults) and a caller's request. A request above the Agent's
 * value is refused with that value named, so the caller can retry within it.
 */
export function resolveAgentRunLimits(params: {
  runtime: Pick<
    AgentRuntime,
    "tier" | "maxTier" | "idleTimeoutMinutes" | "ttlHours" | "maxCostUsd"
  >;
  requested?: AgentRunLimitsRequest | null;
}): AgentRunLimits {
  const { runtime } = params;
  const requested = params.requested ?? {};
  const agentTier = agentRuntimeTier(runtime);
  const maxTier = agentRuntimeMaxTier(runtime);
  const idleTimeoutMinutes =
    runtime.idleTimeoutMinutes ?? config.agentRuntime.defaultIdleTimeoutMinutes;
  const maxDurationHours =
    runtime.ttlHours ?? config.agentRuntime.defaultTtlHours;
  const maxCostUsd = runtime.maxCostUsd ?? null;
  if (
    requested.tier !== undefined &&
    tierRank(requested.tier) > tierRank(maxTier)
  )
    throw new ApiError(
      400,
      `Tier ${requested.tier} is above this Agent's largest tier ${maxTier}`,
    );
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
