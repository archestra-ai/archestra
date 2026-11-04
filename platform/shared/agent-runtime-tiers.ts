import { z } from "zod";

/**
 * Agent Runtime tiers: the container sizes a run can get. An organization's
 * administrators define the list, name each tier and set its CPU and memory.
 * Memory follows the CPU unless overridden. A tier can also size its runs'
 * workspace volume, for work that needs more than the deployment's default. The names are the
 * organization's own: S, M and L are only
 * the defaults a new organization starts with. Agents and callers choose a
 * tier by its size, as `sortAgentRuntimeTiers` orders them, and refer to it
 * by name.
 */

/** Smallest CPU request or limit a tier may set. */
export const AGENT_RUNTIME_TIER_MIN_CPU = 0.1;
/** Largest CPU request a tier may ask for one container. */
export const AGENT_RUNTIME_TIER_MAX_CPU_REQUEST = 256;
/** Largest CPU limit a tier may set. */
export const AGENT_RUNTIME_TIER_MAX_CPU_LIMIT = 256;
/** Most spare containers one tier keeps ready per pool. */
export const AGENT_RUNTIME_TIER_MAX_WARM_SPARES = 10;
export const AGENT_RUNTIME_TIER_MAX_COUNT = 12;
export const AGENT_RUNTIME_TIER_NAME_MAX_LENGTH = 32;
/**
 * Memory per CPU of request, in GiB. A tier's memory request is this much per
 * requested CPU. The memory limit is the maximum of twice the effective
 * memory request, this much per requested CPU, and this much per CPU limit.
 */
export const AGENT_RUNTIME_MEMORY_GIB_PER_CPU = 2;

/** What an administrator sets for one tier. */
export interface AgentRuntimeTierDefinition {
  name: string;
  /** CPUs requested for a run's container. */
  cpuRequest: number;
  /** CPUs the container may use at most; null means no limit. */
  cpuLimit: number | null;
  /** Memory overrides in MiB; null or absent follows the CPU-derived default. */
  memoryRequestMiB?: number | null;
  memoryLimitMiB?: number | null;
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

/** A tier with resolved memory and spare counts. */
export interface AgentRuntimeTierSize extends AgentRuntimeTierDefinition {
  warmSpares: number;
  /** Whether the tier keeps spares at all: what an administrator chose. */
  pooled: boolean;
  memoryRequestMiB: number;
  memoryLimitMiB: number;
  /** Present only when the administrator set an explicit memory amount. */
  memoryRequestMiBOverride?: number;
  memoryLimitMiBOverride?: number;
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
    {
      name: "L",
      cpuRequest: 8,
      cpuLimit: null,
      warmSpares: 0,
      workspaceGiB: null,
    },
  ],
  defaultTier: "M",
};

const MIB_PER_GIB = 1024;

/** Derive memory in MiB from CPU and the effective memory request. */
export function agentRuntimeTierMemory(params: {
  cpuRequest: number;
  cpuLimit: number | null;
  memoryRequestMiB?: number | null;
}): { memoryRequestMiB: number; memoryLimitMiB: number } {
  const { cpuRequest, cpuLimit } = params;
  const perCpu = AGENT_RUNTIME_MEMORY_GIB_PER_CPU * MIB_PER_GIB;
  const memoryRequestMiB =
    params.memoryRequestMiB ?? Math.round(cpuRequest * perCpu);
  const memoryLimitMiB = Math.max(
    2 * memoryRequestMiB,
    Math.round(cpuRequest * perCpu),
    Math.round((cpuLimit ?? cpuRequest) * perCpu),
  );
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

/** MiB in GiB, to two decimals: the sizes a run reads as numbers. */
export function gibFromMiB(mib: number): number {
  return Math.round((mib / MIB_PER_GIB) * 100) / 100;
}

/** A memory amount for people: "4 GiB", "1.5 GiB", "512 MiB". */
export function formatMemory(mib: number): string {
  if (mib % MIB_PER_GIB === 0) return `${mib / MIB_PER_GIB} GiB`;
  if (mib >= MIB_PER_GIB) return `${(mib / MIB_PER_GIB).toFixed(1)} GiB`;
  return `${mib} MiB`;
}

/**
 * A tier's size in a few words: "4 CPU, 8 GiB, 20 GiB workspace". The
 * workspace is the tier's own size, or the deployment's default when given;
 * without either it is left out.
 */
export function summarizeAgentRuntimeTier(
  tier: Pick<
    AgentRuntimeTierSize,
    "cpuRequest" | "memoryRequestMiB" | "workspaceGiB"
  >,
  defaultWorkspaceGiB?: number,
): string {
  const workspaceGiB = tier.workspaceGiB ?? defaultWorkspaceGiB ?? null;
  const workspace =
    workspaceGiB === null ? "" : `, ${workspaceGiB} GiB workspace`;
  return `${tier.cpuRequest} CPU, ${formatMemory(tier.memoryRequestMiB)}${workspace}`;
}

/**
 * A tier's size for people: "4 CPU, 8 GiB (16 GiB limit), 60 GiB workspace".
 * The workspace is named when the tier sizes it, or always when the
 * deployment's default size is given, so a list of tiers reads alike.
 */
export function describeAgentRuntimeTier(
  tier: AgentRuntimeTierSize,
  defaultWorkspaceGiB?: number,
): string {
  const cpu = `${tier.cpuRequest} CPU${tier.cpuLimit !== null ? ` (${tier.cpuLimit} limit)` : ""}`;
  const workspaceGiB = tier.workspaceGiB ?? defaultWorkspaceGiB ?? null;
  const workspace =
    workspaceGiB === null ? "" : `, ${workspaceGiB} GiB workspace`;
  return `${cpu}, ${formatMemory(tier.memoryRequestMiB)} (${formatMemory(tier.memoryLimitMiB)} limit)${workspace}`;
}

/**
 * Smallest first: by CPU request, CPU limit (no limit last), memory, then name.
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
      tierMemory(a).memoryRequestMiB - tierMemory(b).memoryRequestMiB ||
      tierMemory(a).memoryLimitMiB - tierMemory(b).memoryLimitMiB ||
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
 * bigger in CPU or memory, with no smaller memory request or limit.
 */
export function nextLargerAgentRuntimeTier(
  tiers: readonly AgentRuntimeTierSize[],
  name: string,
): AgentRuntimeTierSize | undefined {
  const sorted = sortAgentRuntimeTiers(tiers);
  const current = findAgentRuntimeTier(sorted, name);
  if (!current) return undefined;
  return sorted.find((tier) => {
    const cpuLimit = tier.cpuLimit ?? Number.POSITIVE_INFINITY;
    const currentCpuLimit = current.cpuLimit ?? Number.POSITIVE_INFINITY;
    return (
      tier.memoryRequestMiB >= current.memoryRequestMiB &&
      tier.memoryLimitMiB >= current.memoryLimitMiB &&
      (tier.cpuRequest > current.cpuRequest ||
        (tier.cpuRequest === current.cpuRequest &&
          (cpuLimit > currentCpuLimit ||
            (cpuLimit === currentCpuLimit &&
              (tier.memoryRequestMiB > current.memoryRequestMiB ||
                tier.memoryLimitMiB > current.memoryLimitMiB)))))
    );
  });
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
// Stored tiers can predate the 0.1-CPU write minimum. Keep their sizes readable.
const StoredCpuRequestSchema = z
  .number()
  .positive()
  .max(
    AGENT_RUNTIME_TIER_MAX_CPU_REQUEST,
    `The CPU request is at most ${AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}`,
  )
  .refine(
    (cpus) => cpus === Math.round(cpus * CPU_DECIMALS) / CPU_DECIMALS,
    "A CPU amount has at most three decimals",
  );
const StoredCpuLimitSchema = z
  .number()
  .positive()
  .max(
    AGENT_RUNTIME_TIER_MAX_CPU_LIMIT,
    `The CPU limit is at most ${AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}`,
  )
  .refine(
    (cpus) => cpus === Math.round(cpus * CPU_DECIMALS) / CPU_DECIMALS,
    "A CPU amount has at most three decimals",
  );
const CpuRequestSchema = StoredCpuRequestSchema.min(
  AGENT_RUNTIME_TIER_MIN_CPU,
  `The CPU request is at least ${AGENT_RUNTIME_TIER_MIN_CPU}`,
);
const CpuLimitSchema = StoredCpuLimitSchema.min(
  AGENT_RUNTIME_TIER_MIN_CPU,
  `The CPU limit is at least ${AGENT_RUNTIME_TIER_MIN_CPU}`,
);
/**
 * A tier's workspace volume size: positive whole GiB. The API schema, save
 * check and settings form all use this rule.
 */
export const AgentRuntimeWorkspaceGiBSchema = z
  .number()
  .int("A workspace size is a whole number of GiB")
  .min(1, "The workspace is at least 1 GiB");
/** Spare counts in stored settings, from before the pooled choice existed. */
const StoredWarmSparesSchema = z
  .number()
  .int()
  .min(0)
  .max(AGENT_RUNTIME_TIER_MAX_WARM_SPARES);

export const AgentRuntimeMemoryMiBSchema = z
  .number()
  .int("Memory is a whole number of MiB")
  .positive("Memory is at least 1 MiB");

/** One tier as an administrator saves it. */
export const AgentRuntimeTierDefinitionSchema = z.strictObject({
  name: TierNameSchema,
  cpuRequest: CpuRequestSchema,
  cpuLimit: CpuLimitSchema.nullable(),
  /** Null restores the derived default; omission preserves an existing override. */
  memoryRequestMiB: AgentRuntimeMemoryMiBSchema.nullable().optional(),
  memoryLimitMiB: AgentRuntimeMemoryMiBSchema.nullable().optional(),
  /**
   * Whether the tier keeps spare containers ready. A pooled tier keeps the
   * deployment's `ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE`; the other keeps none.
   */
  pooled: z.boolean(),
  /**
   * Size of a run's workspace volume in GiB; null follows the deployment's
   * default. Left out, the tier keeps the size it has, so a client that does
   * not know the field never erases it.
   */
  workspaceGiB: AgentRuntimeWorkspaceGiBSchema.nullable().optional(),
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
      ...(tier.memoryRequestMiB == null
        ? {}
        : { memoryRequestMiBOverride: tier.memoryRequestMiB }),
      ...(tier.memoryLimitMiB == null
        ? {}
        : { memoryLimitMiBOverride: tier.memoryLimitMiB }),
      ...tierMemory(tier),
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
  const cpuRequest = StoredCpuRequestSchema.safeParse(value.cpuRequest);
  if (!name.success || !cpuRequest.success) return null;
  const cpuLimit = StoredCpuLimitSchema.nullable().safeParse(
    value.cpuLimit ?? null,
  );
  const warmSpares = StoredWarmSparesSchema.nullable().safeParse(
    value.warmSpares ?? null,
  );
  const workspaceGiB = AgentRuntimeWorkspaceGiBSchema.nullable().safeParse(
    value.workspaceGiB ?? null,
  );
  const memoryRequest = AgentRuntimeMemoryMiBSchema.safeParse(
    value.memoryRequestMiB,
  );
  const memoryLimit = AgentRuntimeMemoryMiBSchema.safeParse(
    value.memoryLimitMiB,
  );
  const memory = {
    ...(memoryRequest.success ? { memoryRequestMiB: memoryRequest.data } : {}),
    ...(memoryLimit.success ? { memoryLimitMiB: memoryLimit.data } : {}),
  };
  // Ignore inconsistent stored overrides rather than emit an invalid Pod.
  const resolvedMemory = tierMemory({
    cpuRequest: cpuRequest.data,
    cpuLimit:
      cpuLimit.success &&
      cpuLimit.data !== null &&
      cpuLimit.data >= cpuRequest.data
        ? cpuLimit.data
        : null,
    ...memory,
  });
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
    ...(AgentRuntimeMemoryMiBSchema.safeParse(resolvedMemory.memoryRequestMiB)
      .success &&
    AgentRuntimeMemoryMiBSchema.safeParse(resolvedMemory.memoryLimitMiB)
      .success &&
    resolvedMemory.memoryLimitMiB >= resolvedMemory.memoryRequestMiB
      ? memory
      : {}),
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
    Pick<
      AgentRuntimeTierDefinition,
      | "name"
      | "cpuRequest"
      | "cpuLimit"
      | "workspaceGiB"
      | "memoryRequestMiB"
      | "memoryLimitMiB"
    >
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
      (tier.memoryRequestMiB != null &&
        !AgentRuntimeMemoryMiBSchema.safeParse(tier.memoryRequestMiB)
          .success) ||
      (tier.memoryLimitMiB != null &&
        !AgentRuntimeMemoryMiBSchema.safeParse(tier.memoryLimitMiB).success)
    )
      problems.push(`${label}: memory is a positive whole number of MiB`);
    else if (tier.memoryRequestMiB != null || tier.memoryLimitMiB != null) {
      const memory = tierMemory(tier);
      if (
        !AgentRuntimeMemoryMiBSchema.safeParse(memory.memoryRequestMiB)
          .success ||
        !AgentRuntimeMemoryMiBSchema.safeParse(memory.memoryLimitMiB).success
      )
        problems.push(
          `${label}: calculated memory exceeds the supported numeric range; set an explicit memory limit`,
        );
      else if (memory.memoryLimitMiB < memory.memoryRequestMiB)
        problems.push(`${label}: the memory limit is below the memory request`);
    }
    if (
      !Number.isFinite(tier.cpuRequest) ||
      tier.cpuRequest < AGENT_RUNTIME_TIER_MIN_CPU ||
      tier.cpuRequest > AGENT_RUNTIME_TIER_MAX_CPU_REQUEST
    )
      problems.push(
        `${label}: the CPU request is at least ${AGENT_RUNTIME_TIER_MIN_CPU} and at most ${AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}`,
      );
    else if (
      tier.cpuRequest !==
      Math.round(tier.cpuRequest * CPU_DECIMALS) / CPU_DECIMALS
    )
      problems.push(`${label}: a CPU amount has at most three decimals`);
    if (tier.cpuLimit !== null) {
      if (
        !Number.isFinite(tier.cpuLimit) ||
        tier.cpuLimit < AGENT_RUNTIME_TIER_MIN_CPU ||
        tier.cpuLimit > AGENT_RUNTIME_TIER_MAX_CPU_LIMIT
      )
        problems.push(
          `${label}: the CPU limit is at least ${AGENT_RUNTIME_TIER_MIN_CPU} and at most ${AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}`,
        );
      else if (
        tier.cpuLimit !==
        Math.round(tier.cpuLimit * CPU_DECIMALS) / CPU_DECIMALS
      )
        problems.push(`${label}: a CPU amount has at most three decimals`);
      else if (tier.cpuLimit < tier.cpuRequest)
        problems.push(`${label}: the CPU limit is below the CPU request`);
    }
    if (
      tier.workspaceGiB !== null &&
      !AgentRuntimeWorkspaceGiBSchema.safeParse(tier.workspaceGiB).success
    )
      problems.push(
        `${label}: the workspace is a positive whole number of GiB`,
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
    // The caller fills a left-out size from the tier's current one first.
    workspaceGiB: input.workspaceGiB ?? null,
    ...(input.memoryRequestMiB == null
      ? {}
      : { memoryRequestMiB: input.memoryRequestMiB }),
    ...(input.memoryLimitMiB == null
      ? {}
      : { memoryLimitMiB: input.memoryLimitMiB }),
  };
}

/** Apply the request override before deriving the limit, then apply its override. */
function tierMemory(
  tier: Pick<
    AgentRuntimeTierDefinition,
    "cpuRequest" | "cpuLimit" | "memoryRequestMiB" | "memoryLimitMiB"
  >,
): { memoryRequestMiB: number; memoryLimitMiB: number } {
  const derived = agentRuntimeTierMemory(tier);
  return {
    memoryRequestMiB: derived.memoryRequestMiB,
    memoryLimitMiB: tier.memoryLimitMiB ?? derived.memoryLimitMiB,
  };
}
