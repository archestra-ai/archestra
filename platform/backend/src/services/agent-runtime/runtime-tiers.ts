import {
  type AgentRuntimeTierSize,
  agentRuntimeTierRank,
  cpuQuantity,
  describeAgentRuntimeTier,
  findAgentRuntimeTier,
  gibFromMiB,
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

/** A tier's workspace volume in GiB, the deployment's when it sets none. */
export function tierWorkspaceGiB(tier: AgentRuntimeTierSize): number {
  return tier.workspaceGiB ?? config.agentRuntime.workspaceStorageGiB;
}

/** A tier's workspace volume as a Kubernetes quantity. */
export function tierWorkspaceStorageSize(tier: AgentRuntimeTierSize): string {
  return tier.workspaceGiB === null
    ? config.agentRuntime.workspaceStorageSize
    : `${tier.workspaceGiB}Gi`;
}

/**
 * A run's system prompt around the one sentence that names its workspace
 * volume, so the sentence can be built for the volume the run got (a larger
 * tier's warm pool may serve it) without touching any other text.
 */
export interface RuntimeSystemPromptParts {
  beforeVolume: string;
  afterVolume: string;
}

/**
 * The system prompt with the sentence about the run's volume. A run whose
 * volume size is unknown (its workspace predates recorded sizes) is told
 * nothing about it rather than a size it may not have.
 */
export function runtimeSystemPrompt(
  parts: RuntimeSystemPromptParts,
  workspaceGiB: number | undefined,
): string {
  const volume =
    workspaceGiB === undefined
      ? ""
      : ` The workspace volume is ${workspaceGiB} GiB in all, including any Docker data.`;
  return `${parts.beforeVolume}${volume}${parts.afterVolume}`;
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
 * these numbers, not by the names. The run's own tier carries the size of the
 * volume the run has, which a continuation keeps from its first turn, and no
 * size when that is unknown.
 */
export function runtimeTiersEnv(
  allowed: readonly AgentRuntimeTierSize[],
  current: string | null,
  currentWorkspaceGiB: number | undefined,
): string {
  const currentName =
    current === null
      ? null
      : tierSize({ tiers: [...allowed], defaultTier: current }, current).name;
  return JSON.stringify(
    allowed.map((tier) => {
      const isCurrent = tier.name === currentName;
      const workspaceGiB = isCurrent
        ? currentWorkspaceGiB
        : tierWorkspaceGiB(tier);
      return {
        name: tier.name,
        cpu: tier.cpuRequest,
        cpu_limit: tier.cpuLimit,
        memory_gib: gibFromMiB(tier.memoryRequestMiB),
        memory_limit_gib: gibFromMiB(tier.memoryLimitMiB),
        ...(workspaceGiB === undefined ? {} : { workspace_gib: workspaceGiB }),
        ...(isCurrent ? { current: true } : {}),
      };
    }),
  );
}

/**
 * The same list with `current` on the served tier alone: a run served from a
 * larger tier's warm pool runs at that size, and its list must say so,
 * including the served volume.
 */
export function retargetRuntimeTiersEnv(
  value: string,
  served: { tier: string; workspaceGiB: number },
  requested: { tier: string; workspaceGiB: number } | undefined,
): string {
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
      if (typeof rest.name !== "string") return rest;
      // The served tier carries the volume the run got; the requested tier
      // goes back to its own size, which a new run at that tier would get.
      if (sameAgentRuntimeTierName(rest.name, served.tier))
        return { ...rest, workspace_gib: served.workspaceGiB, current: true };
      if (requested && sameAgentRuntimeTierName(rest.name, requested.tier))
        return { ...rest, workspace_gib: requested.workspaceGiB };
      return rest;
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
  resolvedTier?: string | null,
): string | null {
  const defaultTierName = agentRuntimeTier(runtime, tiers);
  const maxTierName = agentRuntimeMaxTier(runtime, tiers);
  if (
    agentRuntimeTierRank(tiers.tiers, maxTierName) >
    agentRuntimeTierRank(tiers.tiers, defaultTierName)
  ) {
    return null;
  }
  const currentTierName = resolvedTier ?? defaultTierName;
  const currentTier = tierSize(tiers, currentTierName);
  return (
    `Scaling up this agent runtime instance is disabled: the runtime tier is fixed to ` +
    `${currentTier.name} (${describeTier(currentTier)}). ` +
    `You cannot scale up this instance; do not attempt to start a run at a larger tier.`
  );
}

const SCALEUP_DISABLED_PATTERN =
  /Scaling up this agent runtime instance is disabled: the runtime tier is fixed to [^\n]+?\. You cannot scale up this instance; do not attempt to start a run at a larger tier\./;

/**
 * Retargets the fixed-tier system instruction in an agent's prompt to match
 * the tier that actually served the launch (e.g. from a warm pool).
 */
export function retargetScaleupDisabledPrompt(
  prompt: string,
  tiersEnv: string,
  targetTier: string,
): string {
  if (!SCALEUP_DISABLED_PATTERN.test(prompt)) return prompt;
  let entries: unknown;
  try {
    entries = JSON.parse(tiersEnv);
  } catch {
    return prompt;
  }
  if (!Array.isArray(entries)) return prompt;
  const entry = entries.find(
    (
      item,
    ): item is {
      name: string;
      cpu: number;
      cpu_limit?: number | null;
      memory_gib: number;
      memory_limit_gib: number;
    } =>
      Boolean(
        item &&
          typeof item === "object" &&
          "name" in item &&
          typeof item.name === "string" &&
          sameAgentRuntimeTierName(item.name, targetTier),
      ),
  );
  if (!entry) return prompt;
  const targetSize: AgentRuntimeTierSize = {
    name: entry.name,
    cpuRequest: entry.cpu,
    cpuLimit: entry.cpu_limit ?? null,
    memoryRequestMiB: Math.round(entry.memory_gib * 1024),
    memoryLimitMiB: Math.round(entry.memory_limit_gib * 1024),
    warmSpares: 0,
    pooled: false,
  };
  const replacement =
    `Scaling up this agent runtime instance is disabled: the runtime tier is fixed to ` +
    `${targetSize.name} (${describeAgentRuntimeTier(targetSize)}). ` +
    `You cannot scale up this instance; do not attempt to start a run at a larger tier.`;
  return prompt.replace(SCALEUP_DISABLED_PATTERN, replacement);
}

function allowedTiersSentence(
  allowed: readonly AgentRuntimeTierSize[],
): string {
  return `Tiers this Agent's runs may use: ${allowed
    .map((tier) => `${tier.name} (${describeTier(tier)})`)
    .join(", ")}.`;
}

/**
 * The limits one run gets from the Agent's settings (its values, else the
 * deployment defaults) and a caller's request. A request above the Agent's
 * value is refused with that value named, so the caller can retry within it.
 * A tier is chosen by name, or by the CPU and memory the work needs, which
 * gives the smallest tier that fits and has no smaller workspace than the
 * Agent's default tier: asking for CPU must not cost the run its disk. The
 * limits carry the workspace size of the chosen tier, which the run records.
 */
export function resolveAgentRunLimits(params: {
  runtime: Pick<
    AgentRuntime,
    "tier" | "maxTier" | "idleTimeoutMinutes" | "ttlHours" | "maxCostUsd"
  >;
  tiers: ResolvedAgentRuntimeTiers;
  requested?: AgentRunLimitsRequest | null;
  currentTier?: string | null;
}): AgentRunLimits {
  const { runtime, tiers } = params;
  const requested = params.requested ?? {};
  const allowed = agentRuntimeAllowedTiers(runtime, tiers);
  const maxTier = agentRuntimeMaxTier(runtime, tiers);
  const defaultTier = agentRuntimeTier(runtime, tiers);
  const defaultWorkspaceGiB = resolveRunWorkspaceGiB(defaultTier, tiers);
  const isScaleupDisabled =
    agentRuntimeTierRank(tiers.tiers, maxTier) <=
    agentRuntimeTierRank(tiers.tiers, defaultTier);
  const callerTierName = params.currentTier
    ? tierSize(tiers, params.currentTier).name
    : null;
  const fixedCeilingName = callerTierName ?? defaultTier;
  const fixedCeilingTier = tierSize(tiers, fixedCeilingName);
  let tier = defaultTier;
  if (
    isScaleupDisabled &&
    callerTierName &&
    agentRuntimeTierRank(tiers.tiers, tier) >
      agentRuntimeTierRank(tiers.tiers, callerTierName)
  ) {
    tier = callerTierName;
  }
  const scaleupDisabledError = () =>
    new ApiError(
      400,
      `Cannot scale up this agent runtime instance: scaling up is disabled and the runtime tier is fixed to ${fixedCeilingTier.name} (${describeTier(fixedCeilingTier)}). This call is not retriable; calling it again will fail.`,
    );

  if (requested.tier !== undefined) {
    const named = findAgentRuntimeTier(tiers.tiers, requested.tier);
    if (!named)
      throw new ApiError(
        400,
        `There is no tier named ${requested.tier}. ${allowedTiersSentence(allowed)}`,
      );
    if (
      isScaleupDisabled &&
      agentRuntimeTierRank(tiers.tiers, named.name) >
        agentRuntimeTierRank(tiers.tiers, fixedCeilingName)
    ) {
      throw scaleupDisabledError();
    }
    if (
      agentRuntimeTierRank(tiers.tiers, named.name) >
      agentRuntimeTierRank(tiers.tiers, maxTier)
    ) {
      if (isScaleupDisabled) {
        throw scaleupDisabledError();
      }
      throw new ApiError(
        400,
        `Tier ${named.name} (${describeTier(named)}) is above this Agent's scaleup tier ${maxTier}. ${allowedTiersSentence(allowed)}`,
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
          `Tier ${named.name} (${describeTier(named)}) has less than the ${need} asked for. ${allowedTiersSentence(allowed)}`,
        );
      }
    } else {
      const hasDisk = (candidate: AgentRuntimeTierSize) =>
        tierWorkspaceGiB(candidate) >= defaultWorkspaceGiB;
      const smallest = allowed.find(
        (candidate) => fits(candidate) && hasDisk(candidate),
      );
      if (!smallest) {
        // With scaleup fixed, the default tier is the largest allowed and
        // always has its own disk, so nothing qualifies only when the work
        // needs a larger tier: the fixed-scaleup refusal is the reason.
        if (isScaleupDisabled) {
          throw scaleupDisabledError();
        }
        throw new ApiError(
          400,
          allowed.some(fits)
            ? `No tier this Agent's runs may use has ${need} and a workspace of at least ${defaultWorkspaceGiB} GiB, the size of its default tier. ${allowedTiersSentence(allowed)}`
            : `No tier this Agent's runs may use has ${need}. ${allowedTiersSentence(allowed)}`,
        );
      }
      if (
        isScaleupDisabled &&
        agentRuntimeTierRank(tiers.tiers, smallest.name) >
          agentRuntimeTierRank(tiers.tiers, fixedCeilingName)
      ) {
        throw scaleupDisabledError();
      }
      tier = smallest.name;
    }
  }
  if (
    isScaleupDisabled &&
    agentRuntimeTierRank(tiers.tiers, tier) >
      agentRuntimeTierRank(tiers.tiers, fixedCeilingName)
  ) {
    throw scaleupDisabledError();
  }
  if (
    !allowed.some((candidate) => candidate.name === tier) ||
    agentRuntimeTierRank(tiers.tiers, tier) >
      agentRuntimeTierRank(tiers.tiers, maxTier)
  ) {
    if (isScaleupDisabled) {
      throw scaleupDisabledError();
    }
    const resolvedTier = tierSize(tiers, tier);
    throw new ApiError(
      400,
      `Tier ${resolvedTier.name} (${describeAgentRuntimeTier(resolvedTier)}) is above this Agent's scaleup tier ${maxTier}. ${allowedTiersSentence(allowed)}`,
    );
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
    workspaceGiB: resolveRunWorkspaceGiB(tier, tiers),
  };
}

// === Internal helpers ===

/** A tier's size for refusal messages, its workspace always named. */
function describeTier(tier: AgentRuntimeTierSize): string {
  return describeAgentRuntimeTier(
    tier,
    config.agentRuntime.workspaceStorageGiB,
  );
}
