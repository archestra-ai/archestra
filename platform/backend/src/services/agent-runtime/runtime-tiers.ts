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
import config, { k8sMemoryQuantityToBytes } from "@/config";
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
 * The workspace volume a run gets, as a Kubernetes quantity: its tier's size,
 * else the deployment's `ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_SIZE`.
 */
export function resolveRunWorkspaceStorageSize(
  tier: string | null,
  tiers: ResolvedAgentRuntimeTiers,
): string {
  return tierWorkspaceStorageSize(tierSize(tiers, tier));
}

/** The same size in GiB, for text and for the Pod's tier list. */
export function resolveRunWorkspaceGiB(
  tier: string | null,
  tiers: ResolvedAgentRuntimeTiers,
): number {
  return tierWorkspaceGiB(tierSize(tiers, tier));
}

/** A tier's workspace volume as a Kubernetes quantity. */
export function tierWorkspaceStorageSize(tier: AgentRuntimeTierSize): string {
  return tier.workspaceGiB === null
    ? config.agentRuntime.workspaceStorageSize
    : `${tier.workspaceGiB}Gi`;
}

/** The deployment's workspace volume size in GiB: what a tier that sets none gives its runs. */
export function defaultWorkspaceGiB(): number {
  return workspaceVolumeGiB(config.agentRuntime.workspaceStorageSize);
}

/** A workspace volume quantity ("20Gi", "500Mi") in GiB, to two decimals. */
export function workspaceVolumeGiB(quantity: string): number {
  const bytes = k8sMemoryQuantityToBytes(quantity);
  // The deployment's value is validated at startup and a tier's is whole GiB,
  // so this names a programming error, not a setting.
  if (bytes === undefined)
    throw new Error(`Unreadable workspace volume size ${quantity}`);
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

/**
 * What a run reads about its volume. A run served from a larger tier's warm
 * pool is told that tier's size instead; see `servedLaunchSpec`.
 */
export function workspaceVolumeSentence(gib: number): string {
  return `The workspace volume is ${gib} GiB in all, including any Docker data.`;
}

/**
 * Tiers whose warm pool may serve a run, in order: the requested tier, then
 * the next larger one while it stays within the Agent's scaleup tier and its
 * workspace volume is no smaller. Never a smaller one: a run sized below what
 * it asked for can run out of memory or disk. A run served from the larger
 * pool runs at that size.
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
      agentRuntimeTierRank(tiers.tiers, max) &&
    tierWorkspaceGiB(larger) >= tierWorkspaceGiB(own)
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
 * run may move to, smallest first, each with its size (CPU, memory and the
 * workspace volume in GiB), and which one the run has. The agent decides by
 * these numbers, not by the names.
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
      workspace_gib: tierWorkspaceGiB(tier),
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

/** A tier's workspace volume in GiB, the deployment's when it sets none. */
function tierWorkspaceGiB(tier: AgentRuntimeTierSize): number {
  return tier.workspaceGiB ?? defaultWorkspaceGiB();
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

function allowedTiersSentence(
  allowed: readonly AgentRuntimeTierSize[],
): string {
  return `Tiers this Agent's runs may use: ${allowed
    .map(
      (tier) =>
        `${tier.name} (${describeAgentRuntimeTier(tier, defaultWorkspaceGiB())})`,
    )
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
    )
      throw new ApiError(
        400,
        `Tier ${named.name} (${describeAgentRuntimeTier(named, defaultWorkspaceGiB())}) is above this Agent's scaleup tier ${maxTier}. ${allowedTiersSentence(allowed)}`,
      );
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
      if (!fits(named))
        throw new ApiError(
          400,
          `Tier ${named.name} (${describeAgentRuntimeTier(named, defaultWorkspaceGiB())}) has less than the ${need} asked for. ${allowedTiersSentence(allowed)}`,
        );
    } else {
      const smallest = allowed.find(fits);
      if (!smallest)
        throw new ApiError(
          400,
          `No tier this Agent's runs may use has ${need}. ${allowedTiersSentence(allowed)}`,
        );
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
