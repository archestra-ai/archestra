import {
  type AgentRuntimeTierSize,
  agentRuntimeTierRank,
  cpuQuantity,
  describeAgentRuntimeTier,
  findAgentRuntimeTier,
  memoryQuantity,
  nextLargerAgentRuntimeTier,
  type ResolvedAgentRuntimeTiers,
  resolveAgentRuntimeTiers,
  sameAgentRuntimeTierName,
  sortAgentRuntimeTiers,
} from "@archestra/shared";
import config from "@/config";
import OrganizationModel from "@/models/organization";
import {
  type AgentRunLimits,
  type AgentRunLimitsRequest,
  type AgentRuntime,
  type AgentRuntimeResources,
  ApiError,
} from "@/types";

/** What the tier resolution takes from the deployment. */
export function agentRuntimeTierDefaults() {
  return { defaultWarmSpares: config.agentRuntime.warmPoolSize };
}

/**
 * The organization's tiers in effect, smallest first: the list its
 * administrators saved (Settings > Agents), or the defaults.
 */
export async function organizationAgentRuntimeTiers(
  organizationId: string,
): Promise<ResolvedAgentRuntimeTiers> {
  const organization = await OrganizationModel.getById(organizationId);
  return resolveAgentRuntimeTiers(
    organization?.agentRuntimeTiers,
    agentRuntimeTierDefaults(),
  );
}

/** The container resources of a tier, as Kubernetes quantities. */
export function tierResources(
  tier: AgentRuntimeTierSize,
): AgentRuntimeResources {
  return {
    cpuRequest: cpuQuantity(tier.cpuRequest),
    ...(tier.cpuLimit !== null ? { cpuLimit: cpuQuantity(tier.cpuLimit) } : {}),
    memoryRequest: memoryQuantity(tier.memoryRequestMiB),
    memoryLimit: memoryQuantity(tier.memoryLimitMiB),
  };
}

type SizedRuntime = Pick<AgentRuntime, "tier" | "maxTier">;

/**
 * A tier by name, else the organization's default tier: a run whose tier was
 * removed since still gets a size.
 */
function tierSize(
  tiers: ResolvedAgentRuntimeTiers,
  name: string | null | undefined,
): AgentRuntimeTierSize {
  return (
    findAgentRuntimeTier(tiers.tiers, name) ??
    findAgentRuntimeTier(tiers.tiers, tiers.defaultTier) ??
    tiers.tiers[0]
  );
}

/**
 * The tier an Agent's runs get by default: its own while the organization
 * has it, else the organization's default tier.
 */
export function agentRuntimeTier(
  runtime: SizedRuntime,
  tiers: ResolvedAgentRuntimeTiers,
): string {
  return tierSize(tiers, runtime.tier).name;
}

/**
 * The largest tier a caller may ask for: the Agent's scaleup tier, never
 * below its default tier.
 */
export function agentRuntimeMaxTier(
  runtime: SizedRuntime,
  tiers: ResolvedAgentRuntimeTiers,
): string {
  const tier = agentRuntimeTier(runtime, tiers);
  const max = findAgentRuntimeTier(tiers.tiers, runtime.maxTier)?.name ?? tier;
  return agentRuntimeTierRank(tiers.tiers, max) >
    agentRuntimeTierRank(tiers.tiers, tier)
    ? max
    : tier;
}

/** The tiers a run of the Agent may use: every tier up to its scaleup tier, smallest first. */
export function agentRuntimeAllowedTiers(
  runtime: SizedRuntime,
  tiers: ResolvedAgentRuntimeTiers,
): AgentRuntimeTierSize[] {
  const max = agentRuntimeMaxTier(runtime, tiers);
  return sortAgentRuntimeTiers(tiers.tiers).slice(
    0,
    agentRuntimeTierRank(tiers.tiers, max) + 1,
  );
}

/** The resources a run gets: its tier's size in the organization. */
export function resolveRunResources(
  tier: string | null,
  tiers: ResolvedAgentRuntimeTiers,
): AgentRuntimeResources {
  return tierResources(tierSize(tiers, tier));
}

/**
 * Tiers whose warm pool may serve a run, in order: the requested tier, then
 * the next larger one while it stays within the Agent's scaleup tier. Never a
 * smaller one: a run sized below what it asked for can run out of memory. A
 * run served from the larger pool runs at that size.
 */
export function warmTierCandidates(
  tier: string,
  max: string,
  tiers: ResolvedAgentRuntimeTiers,
): AgentRuntimeTierSize[] {
  const own = tierSize(tiers, tier);
  const larger = nextLargerAgentRuntimeTier(tiers.tiers, own.name);
  return larger &&
    agentRuntimeTierRank(tiers.tiers, larger.name) <=
      agentRuntimeTierRank(tiers.tiers, max)
    ? [own, larger]
    : [own];
}

/**
 * Spare containers a tier's warm pool keeps: the tier's own count (a tier
 * saved without one follows the deployment's
 * `ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE`). None while warm pools are off.
 */
export function warmPoolReplicas(
  tiers: ResolvedAgentRuntimeTiers,
  tier: string,
): number {
  if (config.agentRuntime.warmPoolSize === 0) return 0;
  return tierSize(tiers, tier).warmSpares;
}

/**
 * What a run's Pod reads in `ARCHESTRA_AGENT_RUNTIME_TIERS`: the tiers the
 * run may move to, smallest first, each with its size, and which one the
 * run has. The agent decides by these numbers, not by the names.
 */
export function runtimeTiersEnv(
  allowed: readonly AgentRuntimeTierSize[],
  current: string | null,
): string {
  return JSON.stringify(
    allowed.map((tier) => ({
      name: tier.name,
      cpu: tier.cpuRequest,
      cpu_limit: tier.cpuLimit,
      memory_gib: gib(tier.memoryRequestMiB),
      memory_limit_gib: gib(tier.memoryLimitMiB),
      ...(current !== null &&
      tier.name ===
        tierSize({ tiers: [...allowed], defaultTier: current }, current).name
        ? { current: true }
        : {}),
    })),
  );
}

function gib(mib: number): number {
  return Math.round((mib / 1024) * 100) / 100;
}

/**
 * The same list with `current` on `tier` alone: a run served from a larger
 * tier's warm pool runs at that size, and its list must say so.
 */
export function retargetRuntimeTiersEnv(value: string, tier: string): string {
  let entries: unknown;
  try {
    entries = JSON.parse(value);
  } catch {
    return value;
  }
  if (!Array.isArray(entries)) return value;
  return JSON.stringify(
    entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") return entry;
      const { current: _current, ...rest } = entry as {
        current?: boolean;
        name?: unknown;
      };
      return typeof rest.name === "string" &&
        sameAgentRuntimeTierName(rest.name, tier)
        ? { ...rest, current: true }
        : rest;
    }),
  );
}

/**
 * Prompt instruction when scaling up this Agent's runtime instance is disabled:
 * the agent is informed that its runtime tier is fixed and it cannot scale up.
 */
export function describeScaleupDisabledPrompt(
  runtime: SizedRuntime,
  tiers: ResolvedAgentRuntimeTiers,
): string | null {
  const currentTierName = agentRuntimeTier(runtime, tiers);
  const maxTierName = agentRuntimeMaxTier(runtime, tiers);
  if (
    agentRuntimeTierRank(tiers.tiers, maxTierName) >
    agentRuntimeTierRank(tiers.tiers, currentTierName)
  ) {
    return null;
  }
  const currentTier = tierSize(tiers, currentTierName);
  return (
    `Scaling up this agent runtime instance is disabled: the runtime tier is fixed to ` +
    `${currentTier.name} (${describeAgentRuntimeTier(currentTier)}). ` +
    `You cannot scale up this instance; do not attempt to start a run at a larger tier.`
  );
}

function allowedTiersSentence(
  allowed: readonly AgentRuntimeTierSize[],
): string {
  return `Tiers this Agent's runs may use: ${allowed
    .map((tier) => `${tier.name} (${describeAgentRuntimeTier(tier)})`)
    .join(", ")}.`;
}

/**
 * The limits one run gets from the Agent's settings (its values, else the
 * deployment defaults) and a caller's request. A request above the Agent's
 * value is refused with that value named, so the caller can retry within it.
 * A tier is chosen by name, or by the CPU and memory the work needs, which
 * gives the smallest tier that fits.
 */
export function resolveAgentRunLimits(params: {
  runtime: Pick<
    AgentRuntime,
    "tier" | "maxTier" | "idleTimeoutMinutes" | "ttlHours" | "maxCostUsd"
  >;
  tiers: ResolvedAgentRuntimeTiers;
  requested?: AgentRunLimitsRequest | null;
}): AgentRunLimits {
  const { runtime, tiers } = params;
  const requested = params.requested ?? {};
  const allowed = agentRuntimeAllowedTiers(runtime, tiers);
  const maxTier = agentRuntimeMaxTier(runtime, tiers);
  let tier = agentRuntimeTier(runtime, tiers);
  const isScaleupDisabled =
    agentRuntimeTierRank(tiers.tiers, maxTier) <=
    agentRuntimeTierRank(tiers.tiers, tier);
  const currentTier = tierSize(tiers, tier);
  const scaleupDisabledError = () =>
    new ApiError(
      400,
      `Cannot scale up this agent runtime instance: scaling up is disabled and the runtime tier is fixed to ${currentTier.name} (${describeAgentRuntimeTier(currentTier)}). This call is not retriable; calling it again will fail.`,
    );

  if (requested.tier !== undefined) {
    const named = findAgentRuntimeTier(tiers.tiers, requested.tier);
    if (!named)
      throw new ApiError(
        400,
        `There is no tier named ${requested.tier}. ${allowedTiersSentence(allowed)}`,
      );
    if (
      agentRuntimeTierRank(tiers.tiers, named.name) >
      agentRuntimeTierRank(tiers.tiers, maxTier)
    ) {
      if (isScaleupDisabled) {
        throw scaleupDisabledError();
      }
      throw new ApiError(
        400,
        `Tier ${named.name} (${describeAgentRuntimeTier(named)}) is above this Agent's scaleup tier ${maxTier}. ${allowedTiersSentence(allowed)}`,
      );
    }
    tier = named.name;
  }
  if (requested.minCpu !== undefined || requested.minMemoryGib !== undefined) {
    const minCpu = requested.minCpu ?? 0;
    const minMemoryMiB = (requested.minMemoryGib ?? 0) * 1024;
    const fits = (candidate: AgentRuntimeTierSize) =>
      candidate.cpuRequest >= minCpu &&
      candidate.memoryRequestMiB >= minMemoryMiB;
    const need = [
      requested.minCpu !== undefined ? `${requested.minCpu} CPU` : null,
      requested.minMemoryGib !== undefined
        ? `${requested.minMemoryGib} GiB of memory`
        : null,
    ]
      .filter(Boolean)
      .join(" and ");
    if (requested.tier !== undefined) {
      const named = tierSize(tiers, tier);
      if (!fits(named)) {
        if (isScaleupDisabled) {
          throw scaleupDisabledError();
        }
        throw new ApiError(
          400,
          `Tier ${named.name} (${describeAgentRuntimeTier(named)}) has less than the ${need} asked for. ${allowedTiersSentence(allowed)}`,
        );
      }
    } else {
      const smallest = allowed.find(fits);
      if (!smallest) {
        if (isScaleupDisabled) {
          throw scaleupDisabledError();
        }
        throw new ApiError(
          400,
          `No tier this Agent's runs may use has ${need}. ${allowedTiersSentence(allowed)}`,
        );
      }
      tier = smallest.name;
    }
  }
  const idleTimeoutMinutes =
    runtime.idleTimeoutMinutes ?? config.agentRuntime.defaultIdleTimeoutMinutes;
  const maxDurationHours =
    runtime.ttlHours ?? config.agentRuntime.defaultTtlHours;
  const maxCostUsd = runtime.maxCostUsd ?? null;
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
    tier,
    idleTimeoutMinutes: requested.idleTimeoutMinutes ?? idleTimeoutMinutes,
    maxDurationHours: requested.maxDurationHours ?? maxDurationHours,
    maxCostUsd: requested.maxCostUsd ?? maxCostUsd,
  };
}
