import { z } from "zod";

/**
 * Agent Runtime tiers: the container sizes a run can get. An organization's
 * administrators define the list, name each tier and set its CPU; memory
 * follows the CPU. A tier can also size its runs' workspace volume, for the
 * work that needs more than the deployment's default. The names are the
 * organization's own: S, M and L are only
 * the defaults a new organization starts with. Agents and callers choose a
 * tier by its size, as `sortAgentRuntimeTiers` orders them, and refer to it
 * by name.
 */

/** Largest CPU request a tier may ask for one container. */
export const AGENT_RUNTIME_TIER_MAX_CPU_REQUEST = 8;
/** Largest CPU limit a tier may set. */
export const AGENT_RUNTIME_TIER_MAX_CPU_LIMIT = 16;
/** Most spare containers one tier keeps ready per pool. */
export const AGENT_RUNTIME_TIER_MAX_WARM_SPARES = 10;
export const AGENT_RUNTIME_TIER_MAX_COUNT = 12;
/** Largest workspace volume a tier may give its runs, in GiB. */
export const AGENT_RUNTIME_TIER_MAX_WORKSPACE_GIB = 1024;
export const AGENT_RUNTIME_TIER_NAME_MAX_LENGTH = 32;
/**
 * Memory per CPU of request, in GiB. A tier's memory request is this much per
 * requested CPU; its memory limit is twice the request, or this much per CPU
 * of the CPU limit when that is lower.
 */
export const AGENT_RUNTIME_MEMORY_GIB_PER_CPU = 2;

/** What an administrator sets for one tier. */
export interface AgentRuntimeTierDefinition {
  name: string;
  /** CPUs requested for a run's container. */
  cpuRequest: number;
  /** CPUs the container may use at most; null means no limit. */
  cpuLimit: number | null;
  /**
   * Spare containers of this tier kept running and empty per warm pool, so a
   * run starts on one in seconds. Null follows the deployment's
   * `ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE`; 0 keeps none. Administrators
   * choose between the two ("pooled" or not); other counts come from
   * settings saved before that choice existed.
   */
  warmSpares: number | null;
  /**
   * Size of a run's workspace volume in GiB. The volume holds the home
   * directory and, for a privileged Agent, its Docker data, so a stack that
   * runs Kubernetes in Docker needs far more than a lite run. Null follows
   * the deployment's `ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_SIZE`.
   */
  workspaceGiB: number | null;
}

export interface AgentRuntimeTierSettings {
  tiers: AgentRuntimeTierDefinition[];
  /** The tier an Agent's runs get when the Agent names none. */
  defaultTier: string;
}

/** A tier with the memory its CPU gives it. Spares are resolved to a number. */
export interface AgentRuntimeTierSize extends AgentRuntimeTierDefinition {
  warmSpares: number;
  /** Whether the tier keeps spares at all: what an administrator chose. */
  pooled: boolean;
  memoryRequestMiB: number;
  memoryLimitMiB: number;
}

/** The tiers in effect for an organization, smallest first. */
export interface ResolvedAgentRuntimeTiers {
  tiers: AgentRuntimeTierSize[];
  defaultTier: string;
}

/**
 * The tiers a new organization starts with. Only the names and CPUs are a
 * choice; the memory follows. L keeps no spares: an idle spare holds its full
 * size, and a large run is rare.
 */
export const DEFAULT_AGENT_RUNTIME_TIERS: AgentRuntimeTierSettings = {
  tiers: [
    {
      name: "S",
      cpuRequest: 2,
      cpuLimit: null,
      warmSpares: null,
      workspaceGiB: null,
    },
    {
      name: "M",
      cpuRequest: 4,
      cpuLimit: null,
      warmSpares: null,
      workspaceGiB: null,
    },
    { name: "L", cpuRequest: 8, cpuLimit: null, warmSpares: 0, workspaceGiB: null },
  ],
  defaultTier: "M",
};

const MIB_PER_GIB = 1024;

/** The memory a tier's CPU gives it, in MiB. */
export function agentRuntimeTierMemory(
  cpuRequest: number,
  cpuLimit: number | null,
): { memoryRequestMiB: number; memoryLimitMiB: number } {
  const perCpu = AGENT_RUNTIME_MEMORY_GIB_PER_CPU * MIB_PER_GIB;
  const memoryRequestMiB = Math.round(cpuRequest * perCpu);
  const doubled = 2 * memoryRequestMiB;
  const memoryLimitMiB =
    cpuLimit === null
      ? doubled
      : Math.min(doubled, Math.round(cpuLimit * perCpu));
  return { memoryRequestMiB, memoryLimitMiB };
}

/** A CPU count as a Kubernetes quantity: whole CPUs plain, fractions in millicores. */
export function cpuQuantity(cpus: number): string {
  return Number.isInteger(cpus) ? String(cpus) : `${Math.round(cpus * 1000)}m`;
}

/** MiB as a Kubernetes quantity: in Gi when whole, else in Mi. */
export function memoryQuantity(mib: number): string {
  return mib % MIB_PER_GIB === 0 ? `${mib / MIB_PER_GIB}Gi` : `${mib}Mi`;
}

/** A memory amount for people: "4 GiB", "1.5 GiB", "512 MiB". */
export function formatMemory(mib: number): string {
  if (mib % MIB_PER_GIB === 0) return `${mib / MIB_PER_GIB} GiB`;
  if (mib >= MIB_PER_GIB) return `${(mib / MIB_PER_GIB).toFixed(1)} GiB`;
  return `${mib} MiB`;
}

/** A tier's size in a few words: "4 CPU, 8 GiB". */
export function summarizeAgentRuntimeTier(
  tier: Pick<AgentRuntimeTierSize, "cpuRequest" | "memoryRequestMiB">,
): string {
  return `${tier.cpuRequest} CPU, ${formatMemory(tier.memoryRequestMiB)}`;
}

/**
 * A tier's size for people: "4 CPU, 8 GiB (16 GiB limit)", with
 * ", 60 GiB workspace" when the tier sizes its runs' volume.
 */
export function describeAgentRuntimeTier(tier: AgentRuntimeTierSize): string {
  const cpu = `${tier.cpuRequest} CPU${tier.cpuLimit !== null ? ` (${tier.cpuLimit} limit)` : ""}`;
  const workspace =
    tier.workspaceGiB === null ? "" : `, ${tier.workspaceGiB} GiB workspace`;
  return `${cpu}, ${formatMemory(tier.memoryRequestMiB)} (${formatMemory(tier.memoryLimitMiB)} limit)${workspace}`;
}

/**
 * Smallest first: by CPU request, then CPU limit (no limit last), then name.
 * The order is the only notion of "larger" the platform has, so a warm spare
 * from the next tier up and a run that moves to a larger tier both follow it.
 */
export function sortAgentRuntimeTiers<T extends AgentRuntimeTierDefinition>(
  tiers: readonly T[],
): T[] {
  return [...tiers].sort(
    (a, b) =>
      a.cpuRequest - b.cpuRequest ||
      (a.cpuLimit ?? Number.POSITIVE_INFINITY) -
        (b.cpuLimit ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name),
  );
}

/** Tier names are compared without regard to case or surrounding spaces. */
export function sameAgentRuntimeTierName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function findAgentRuntimeTier<T extends { name: string }>(
  tiers: readonly T[],
  name: string | null | undefined,
): T | undefined {
  if (!name) return undefined;
  return tiers.find((tier) => sameAgentRuntimeTierName(tier.name, name));
}

/** Position in the size order; -1 for a name the organization has no tier for. */
export function agentRuntimeTierRank(
  tiers: readonly AgentRuntimeTierSize[],
  name: string,
): number {
  return sortAgentRuntimeTiers(tiers).findIndex((tier) =>
    sameAgentRuntimeTierName(tier.name, name),
  );
}

/**
 * The next larger tier: the first one after `name` in the size order that is
 * bigger in CPU request or CPU limit, or undefined when none is.
 */
export function nextLargerAgentRuntimeTier(
  tiers: readonly AgentRuntimeTierSize[],
  name: string,
): AgentRuntimeTierSize | undefined {
  const sorted = sortAgentRuntimeTiers(tiers);
  const current = findAgentRuntimeTier(sorted, name);
  if (!current) return undefined;
  return sorted.find(
    (tier) =>
      tier.cpuRequest > current.cpuRequest ||
      (tier.cpuRequest === current.cpuRequest &&
        (tier.cpuLimit ?? Number.POSITIVE_INFINITY) >
          (current.cpuLimit ?? Number.POSITIVE_INFINITY)),
  );
}

const CPU_DECIMALS = 1000;

const TierNameSchema = z
  .string()
  .trim()
  .min(1, "Name a tier")
  .max(
    AGENT_RUNTIME_TIER_NAME_MAX_LENGTH,
    `A tier name has at most ${AGENT_RUNTIME_TIER_NAME_MAX_LENGTH} characters`,
  );
const CpuRequestSchema = z
  .number()
  .positive("The CPU request is more than 0")
  .max(
    AGENT_RUNTIME_TIER_MAX_CPU_REQUEST,
    `The CPU request is at most ${AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}`,
  )
  .refine(
    (cpus) => Number.isInteger(cpus * CPU_DECIMALS),
    "A CPU amount has at most three decimals",
  );
const CpuLimitSchema = z
  .number()
  .positive("The CPU limit is more than 0")
  .max(
    AGENT_RUNTIME_TIER_MAX_CPU_LIMIT,
    `The CPU limit is at most ${AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}`,
  )
  .refine(
    (cpus) => Number.isInteger(cpus * CPU_DECIMALS),
    "A CPU amount has at most three decimals",
  );
/** A workspace volume size: whole GiB, from 1 to the largest a tier may give. */
const WorkspaceGiBSchema = z
  .number()
  .int("A workspace size is a whole number of GiB")
  .min(1, "The workspace is at least 1 GiB")
  .max(
    AGENT_RUNTIME_TIER_MAX_WORKSPACE_GIB,
    `The workspace is at most ${AGENT_RUNTIME_TIER_MAX_WORKSPACE_GIB} GiB`,
  );
/** Spare counts in stored settings, from before the pooled choice existed. */
const StoredWarmSparesSchema = z
  .number()
  .int()
  .min(0)
  .max(AGENT_RUNTIME_TIER_MAX_WARM_SPARES);

/** One tier as an administrator saves it. */
export const AgentRuntimeTierDefinitionSchema = z.strictObject({
  name: TierNameSchema,
  cpuRequest: CpuRequestSchema,
  cpuLimit: CpuLimitSchema.nullable(),
  /**
   * Whether the tier keeps spare containers ready. A pooled tier keeps the
   * deployment's `ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE`; the other keeps none.
   */
  pooled: z.boolean(),
  /**
   * Size of a run's workspace volume in GiB; null, or left out, follows the
   * deployment's default.
   */
  workspaceGiB: WorkspaceGiBSchema.nullable().default(null),
  /**
   * The tier's name before this save, when the save renames it. Agents that
   * name the old tier follow the rename.
   */
  previousName: TierNameSchema.optional(),
});
export type AgentRuntimeTierDefinitionInput = z.infer<
  typeof AgentRuntimeTierDefinitionSchema
>;

/** The whole list, as the settings form saves it. */
export const AgentRuntimeTierSettingsSchema = z.strictObject({
  tiers: z
    .array(AgentRuntimeTierDefinitionSchema)
    .min(1, "Keep at least one tier")
    .max(
      AGENT_RUNTIME_TIER_MAX_COUNT,
      `At most ${AGENT_RUNTIME_TIER_MAX_COUNT} tiers`,
    ),
  defaultTier: TierNameSchema,
});
export type AgentRuntimeTierSettingsInput = z.infer<
  typeof AgentRuntimeTierSettingsSchema
>;

/**
 * What the organization column may hold: read leniently, so a value written by
 * another build never fails the organization read. `resolveAgentRuntimeTiers`
 * makes sense of it, including the first version, which kept S, M and L as
 * keys with per-field overrides.
 */
export const StoredAgentRuntimeTierSettingsSchema = z.record(
  z.string(),
  z.unknown(),
);
export type StoredAgentRuntimeTierSettings = z.infer<
  typeof StoredAgentRuntimeTierSettingsSchema
>;

/** What `resolveAgentRuntimeTiers` needs from the deployment. */
export interface AgentRuntimeTierDefaults {
  /** `ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE`: spares for a tier that names none. */
  defaultWarmSpares: number;
}

/**
 * The tiers in effect, smallest first: the organization's saved list, or the
 * defaults. Anything unreadable in the saved value falls back to a default,
 * field by field, so an old or damaged value never leaves an organization
 * without tiers.
 */
export function resolveAgentRuntimeTiers(
  stored: StoredAgentRuntimeTierSettings | null | undefined,
  defaults: AgentRuntimeTierDefaults,
): ResolvedAgentRuntimeTiers {
  const settings = storedToSettings(stored);
  const tiers = sortAgentRuntimeTiers(
    settings.tiers.map((tier) => ({
      ...tier,
      warmSpares: tier.warmSpares ?? defaults.defaultWarmSpares,
      pooled: tier.warmSpares === null || tier.warmSpares > 0,
      ...agentRuntimeTierMemory(tier.cpuRequest, tier.cpuLimit),
    })),
  );
  const defaultTier =
    findAgentRuntimeTier(tiers, settings.defaultTier)?.name ??
    findAgentRuntimeTier(tiers, DEFAULT_AGENT_RUNTIME_TIERS.defaultTier)
      ?.name ??
    tiers[0].name;
  return { tiers, defaultTier };
}

/** The saved definitions without the deployment's defaults applied. */
export function storedToSettings(
  stored: StoredAgentRuntimeTierSettings | null | undefined,
): AgentRuntimeTierSettings {
  if (!stored) return structuredClone(DEFAULT_AGENT_RUNTIME_TIERS);
  if (Array.isArray(stored.tiers)) {
    const tiers = stored.tiers.flatMap((entry) => {
      const tier = readTier(entry);
      return tier ? [tier] : [];
    });
    if (tiers.length > 0) {
      return {
        tiers,
        defaultTier:
          typeof stored.defaultTier === "string"
            ? stored.defaultTier
            : DEFAULT_AGENT_RUNTIME_TIERS.defaultTier,
      };
    }
    return structuredClone(DEFAULT_AGENT_RUNTIME_TIERS);
  }
  return legacyToSettings(stored);
}

function readTier(entry: unknown): AgentRuntimeTierDefinition | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, unknown>;
  const name = TierNameSchema.safeParse(value.name);
  const cpuRequest = CpuRequestSchema.safeParse(value.cpuRequest);
  if (!name.success || !cpuRequest.success) return null;
  const cpuLimit = CpuLimitSchema.nullable().safeParse(value.cpuLimit ?? null);
  const warmSpares = StoredWarmSparesSchema.nullable().safeParse(
    value.warmSpares ?? null,
  );
  const workspaceGiB = WorkspaceGiBSchema.nullable().safeParse(
    value.workspaceGiB ?? null,
  );
  return {
    name: name.data,
    cpuRequest: cpuRequest.data,
    cpuLimit:
      cpuLimit.success &&
      (cpuLimit.data === null || cpuLimit.data >= cpuRequest.data)
        ? cpuLimit.data
        : null,
    warmSpares: warmSpares.success ? warmSpares.data : null,
    workspaceGiB: workspaceGiB.success ? workspaceGiB.data : null,
  };
}

/**
 * The first saved shape: S, M and L as keys, each with the fields an
 * administrator changed as Kubernetes quantities. CPU values carry over;
 * memory now follows the CPU, so memory overrides are dropped.
 */
function legacyToSettings(
  stored: StoredAgentRuntimeTierSettings,
): AgentRuntimeTierSettings {
  const tiers = DEFAULT_AGENT_RUNTIME_TIERS.tiers.map((tier) => {
    const overrides = stored[tier.name];
    if (!overrides || typeof overrides !== "object") return { ...tier };
    const value = overrides as Record<string, unknown>;
    const cpuRequest = parseCpuQuantity(value.cpuRequest);
    const cpuLimit =
      value.cpuLimit === null ? null : parseCpuQuantity(value.cpuLimit);
    const warmSpares = StoredWarmSparesSchema.safeParse(value.warmPoolSize);
    const request =
      cpuRequest !== null &&
      cpuRequest > 0 &&
      cpuRequest <= AGENT_RUNTIME_TIER_MAX_CPU_REQUEST
        ? cpuRequest
        : tier.cpuRequest;
    return {
      name: tier.name,
      cpuRequest: request,
      cpuLimit:
        cpuLimit !== null &&
        cpuLimit >= request &&
        cpuLimit <= AGENT_RUNTIME_TIER_MAX_CPU_LIMIT
          ? cpuLimit
          : value.cpuLimit === null
            ? null
            : tier.cpuLimit,
      warmSpares: warmSpares.success
        ? warmSpares.data
        : value.warmPoolSize === null
          ? null
          : tier.warmSpares,
      // The first shape predates per-tier volumes.
      workspaceGiB: null,
    };
  });
  return { tiers, defaultTier: DEFAULT_AGENT_RUNTIME_TIERS.defaultTier };
}

/** "2", "0.5" or "500m" as a CPU count, to three decimals; null otherwise. */
export function parseCpuQuantity(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)(m?)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const cpus = match[2] === "m" ? amount / 1000 : amount;
  return Math.round(cpus * CPU_DECIMALS) / CPU_DECIMALS;
}

/**
 * Problems that stop a save, in words for the settings form and the API: a
 * missing or repeated name, a CPU request or limit out of range, a limit below
 * its request, a workspace size out of range, or a default tier that is not
 * in the list. The schema catches the type errors; these are the rules
 * between fields.
 */
export function agentRuntimeTierProblems(settings: {
  tiers: ReadonlyArray<
    Pick<AgentRuntimeTierDefinition, "name" | "cpuRequest" | "cpuLimit"> &
      Partial<Pick<AgentRuntimeTierDefinition, "workspaceGiB">>
  >;
  defaultTier: string;
}): string[] {
  const problems: string[] = [];
  if (settings.tiers.length === 0) problems.push("Keep at least one tier");
  if (settings.tiers.length > AGENT_RUNTIME_TIER_MAX_COUNT)
    problems.push(`At most ${AGENT_RUNTIME_TIER_MAX_COUNT} tiers`);
  const seen = new Set<string>();
  for (const tier of settings.tiers) {
    const name = tier.name.trim();
    const label = name ? `Tier ${name}` : "A tier without a name";
    if (!name) problems.push("Name every tier");
    else if (name.length > AGENT_RUNTIME_TIER_NAME_MAX_LENGTH)
      problems.push(
        `${label}: a name has at most ${AGENT_RUNTIME_TIER_NAME_MAX_LENGTH} characters`,
      );
    const key = name.toLowerCase();
    if (name && seen.has(key)) problems.push(`Two tiers are named ${name}`);
    seen.add(key);
    if (
      !Number.isFinite(tier.cpuRequest) ||
      tier.cpuRequest <= 0 ||
      tier.cpuRequest > AGENT_RUNTIME_TIER_MAX_CPU_REQUEST
    )
      problems.push(
        `${label}: the CPU request is more than 0 and at most ${AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}`,
      );
    else if (!Number.isInteger(tier.cpuRequest * CPU_DECIMALS))
      problems.push(`${label}: a CPU amount has at most three decimals`);
    if (tier.cpuLimit !== null) {
      if (
        !Number.isFinite(tier.cpuLimit) ||
        tier.cpuLimit <= 0 ||
        tier.cpuLimit > AGENT_RUNTIME_TIER_MAX_CPU_LIMIT
      )
        problems.push(
          `${label}: the CPU limit is more than 0 and at most ${AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}`,
        );
      else if (!Number.isInteger(tier.cpuLimit * CPU_DECIMALS))
        problems.push(`${label}: a CPU amount has at most three decimals`);
      else if (tier.cpuLimit < tier.cpuRequest)
        problems.push(`${label}: the CPU limit is below the CPU request`);
    }
    if (
      tier.workspaceGiB !== null &&
      tier.workspaceGiB !== undefined &&
      (!Number.isInteger(tier.workspaceGiB) ||
        tier.workspaceGiB < 1 ||
        tier.workspaceGiB > AGENT_RUNTIME_TIER_MAX_WORKSPACE_GIB)
    )
      problems.push(
        `${label}: the workspace is a whole number of GiB from 1 to ${AGENT_RUNTIME_TIER_MAX_WORKSPACE_GIB}`,
      );
  }
  if (
    settings.tiers.length > 0 &&
    !findAgentRuntimeTier(settings.tiers, settings.defaultTier)
  )
    problems.push(
      settings.defaultTier.trim()
        ? `The default tier ${settings.defaultTier.trim()} is not in the list`
        : "Choose a default tier",
    );
  return problems;
}

/** What the organization stores for a tier an administrator saved. */
export function agentRuntimeTierDefinitionFromInput(
  input: AgentRuntimeTierDefinitionInput,
): AgentRuntimeTierDefinition {
  return {
    name: input.name,
    cpuRequest: input.cpuRequest,
    cpuLimit: input.cpuLimit,
    warmSpares: input.pooled ? null : 0,
    workspaceGiB: input.workspaceGiB,
  };
}
