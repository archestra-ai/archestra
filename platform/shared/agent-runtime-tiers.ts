import { z } from "zod";
import {
  isValidK8sCpuQuantity,
  isValidK8sMemoryQuantity,
} from "./mcp-orchestrator";

/** Agent Runtime tiers, smallest to largest. */
export const AGENT_RUNTIME_TIERS = ["S", "M", "L"] as const;
export type AgentRuntimeTierName = (typeof AGENT_RUNTIME_TIERS)[number];

/** The container size of one tier and the warm spares its pools keep. */
export interface AgentRuntimeTierSize {
  cpuRequest: string;
  /** Null: no CPU limit. */
  cpuLimit: string | null;
  memoryRequest: string;
  memoryLimit: string;
  /** Spares per warm pool; null follows ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE. */
  warmPoolSize: number | null;
}

/**
 * Code defaults only. An administrator replaces any value per tier in the
 * organization's settings (`agentRuntimeTiers`); `resolveAgentRuntimeTiers`
 * gives the sizes in effect. No CPU limit by default: throttling an agent loop
 * mid-turn produces confusing timeouts rather than back-pressure. L keeps no
 * warm spares: its runs are rare, and an idle L spare holds 8 CPU and 16 GiB.
 */
export const DEFAULT_AGENT_RUNTIME_TIERS: Record<
  AgentRuntimeTierName,
  AgentRuntimeTierSize
> = {
  S: {
    cpuRequest: "2",
    cpuLimit: null,
    memoryRequest: "4Gi",
    memoryLimit: "8Gi",
    warmPoolSize: null,
  },
  M: {
    cpuRequest: "4",
    cpuLimit: null,
    memoryRequest: "8Gi",
    memoryLimit: "16Gi",
    warmPoolSize: null,
  },
  L: {
    cpuRequest: "8",
    cpuLimit: null,
    memoryRequest: "16Gi",
    memoryLimit: "32Gi",
    warmPoolSize: 0,
  },
};

export const AGENT_RUNTIME_TIER_MAX_WARM_POOL_SIZE = 10;

const CpuQuantitySchema = z
  .string()
  .trim()
  .refine(isValidK8sCpuQuantity, "Enter a CPU amount such as 2 or 500m");
const MemoryQuantitySchema = z
  .string()
  .trim()
  .refine(isValidK8sMemoryQuantity, "Enter a memory amount such as 4Gi");
const WarmPoolSizeSchema = z
  .number()
  .int()
  .min(0)
  .max(AGENT_RUNTIME_TIER_MAX_WARM_POOL_SIZE);

/** What an administrator may set for one tier. An omitted field keeps the default. */
export const AgentRuntimeTierOverrideSchema = z.strictObject({
  cpuRequest: CpuQuantitySchema.optional(),
  cpuLimit: CpuQuantitySchema.nullable().optional(),
  memoryRequest: MemoryQuantitySchema.optional(),
  memoryLimit: MemoryQuantitySchema.optional(),
  warmPoolSize: WarmPoolSizeSchema.nullable().optional(),
});
export type AgentRuntimeTierOverride = z.infer<
  typeof AgentRuntimeTierOverrideSchema
>;

export const AgentRuntimeTierSettingsSchema = z.strictObject({
  S: AgentRuntimeTierOverrideSchema.optional(),
  M: AgentRuntimeTierOverrideSchema.optional(),
  L: AgentRuntimeTierOverrideSchema.optional(),
});
export type AgentRuntimeTierSettings = z.infer<
  typeof AgentRuntimeTierSettingsSchema
>;

/**
 * What the organization column may hold: read leniently, so a value written by
 * another build never fails the organization read. `resolveAgentRuntimeTiers`
 * ignores any field that does not validate.
 */
export const StoredAgentRuntimeTierSettingsSchema = z.partialRecord(
  z.enum(AGENT_RUNTIME_TIERS),
  z.record(z.string(), z.unknown()),
);

/** Each tier's size in effect: the stored overrides over the code defaults. */
export function resolveAgentRuntimeTiers(
  settings:
    | z.infer<typeof StoredAgentRuntimeTierSettingsSchema>
    | null
    | undefined,
): Record<AgentRuntimeTierName, AgentRuntimeTierSize> {
  const resolved = structuredClone(DEFAULT_AGENT_RUNTIME_TIERS);
  for (const tier of AGENT_RUNTIME_TIERS) {
    const stored = settings?.[tier];
    if (!stored) continue;
    const size = resolved[tier];
    const pick = <T>(schema: z.ZodType<T>, value: unknown) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    };
    const cpuRequest = pick(CpuQuantitySchema, stored.cpuRequest);
    if (cpuRequest !== undefined) size.cpuRequest = cpuRequest;
    const cpuLimit = pick(CpuQuantitySchema.nullable(), stored.cpuLimit);
    if (cpuLimit !== undefined) size.cpuLimit = cpuLimit;
    const memoryRequest = pick(MemoryQuantitySchema, stored.memoryRequest);
    if (memoryRequest !== undefined) size.memoryRequest = memoryRequest;
    const memoryLimit = pick(MemoryQuantitySchema, stored.memoryLimit);
    if (memoryLimit !== undefined) size.memoryLimit = memoryLimit;
    const warmPoolSize = pick(
      WarmPoolSizeSchema.nullable(),
      stored.warmPoolSize,
    );
    if (warmPoolSize !== undefined) size.warmPoolSize = warmPoolSize;
  }
  return resolved;
}

/**
 * Problems with a set of tiers in effect, for the settings form and the API:
 * each limit at or above its request, and S, M and L in increasing order of
 * requests and limits, so a run that falls back to the next larger tier's pool
 * never gets less than its own tier gives.
 */
export function agentRuntimeTierProblems(
  tiers: Record<AgentRuntimeTierName, AgentRuntimeTierSize>,
): string[] {
  const problems: string[] = [];
  for (const tier of AGENT_RUNTIME_TIERS) {
    const size = tiers[tier];
    if (
      size.cpuLimit !== null &&
      cpuMillicores(size.cpuLimit) < cpuMillicores(size.cpuRequest)
    )
      problems.push(`Tier ${tier}: the CPU limit is below the CPU request`);
    if (memoryBytes(size.memoryLimit) < memoryBytes(size.memoryRequest))
      problems.push(
        `Tier ${tier}: the memory limit is below the memory request`,
      );
  }
  for (let index = 1; index < AGENT_RUNTIME_TIERS.length; index++) {
    const smaller = AGENT_RUNTIME_TIERS[index - 1];
    const larger = AGENT_RUNTIME_TIERS[index];
    if (
      cpuMillicores(tiers[larger].cpuRequest) <
        cpuMillicores(tiers[smaller].cpuRequest) ||
      memoryBytes(tiers[larger].memoryRequest) <
        memoryBytes(tiers[smaller].memoryRequest)
    )
      problems.push(`Tier ${larger} requests less than tier ${smaller}`);
    if (
      memoryBytes(tiers[larger].memoryLimit) <
      memoryBytes(tiers[smaller].memoryLimit)
    )
      problems.push(
        `Tier ${larger} has a lower memory limit than tier ${smaller}`,
      );
    // No CPU limit is the most a tier can allow.
    const largerCpu = tiers[larger].cpuLimit;
    const smallerCpu = tiers[smaller].cpuLimit;
    if (largerCpu !== null && smallerCpu === null)
      problems.push(`Tier ${larger} limits CPU and tier ${smaller} does not`);
    else if (
      largerCpu !== null &&
      smallerCpu !== null &&
      cpuMillicores(largerCpu) < cpuMillicores(smallerCpu)
    )
      problems.push(
        `Tier ${larger} has a lower CPU limit than tier ${smaller}`,
      );
  }
  return problems;
}

function cpuMillicores(value: string): number {
  return value.endsWith("m")
    ? Number(value.slice(0, -1))
    : Number(value) * 1000;
}

const MEMORY_UNITS: Record<string, number> = {
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

function memoryBytes(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]*)$/.exec(value.trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * (MEMORY_UNITS[match[2]] ?? Number.NaN);
}
