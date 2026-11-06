import {
  AGENT_RUNTIME_TIER_MAX_CPU_LIMIT,
  AGENT_RUNTIME_TIER_MAX_CPU_REQUEST,
  AGENT_RUNTIME_TIER_MIN_CPU,
  AGENT_RUNTIME_TIER_NAME_MAX_LENGTH,
  AgentRuntimeMemoryMiBSchema,
  type AgentRuntimeTierDefinitionInput,
  type AgentRuntimeTierSettingsInput,
  AgentRuntimeWorkspaceGiBSchema,
  agentRuntimeTierMemory,
  sameAgentRuntimeTierName,
} from "@archestra/shared";

/** A tier in effect, as the API lists it. */
export interface RuntimeTierSize {
  name: string;
  cpuRequest: number;
  cpuLimit: number | null;
  warmSpares: number;
  pooled: boolean;
  memoryRequestMiB: number;
  memoryLimitMiB: number;
  memoryRequestMiBOverride?: number;
  memoryLimitMiBOverride?: number;
  /** The run's workspace volume in GiB; null follows the deployment's default. */
  workspaceGiB: number | null;
}

export interface RuntimeTiersInEffect {
  tiers: RuntimeTierSize[];
  defaultTier: string;
  /** The deployment's workspace volume size in GiB, for tiers that set none. */
  defaultWorkspaceGiB: number;
}

/** The dialog's fields as typed. */
export interface RuntimeTierFormValues {
  name: string;
  cpuRequest: string;
  cpuLimit: string;
  /** Blank follows the CPU-derived default. */
  memoryRequestGiB: string;
  memoryLimitGiB: string;
  /** Blank keeps the deployment's default. */
  workspaceGiB: string;
  pooled: boolean;
  isDefault: boolean;
}

export type RuntimeTierFormField =
  | "name"
  | "cpuRequest"
  | "cpuLimit"
  | "memoryRequestGiB"
  | "memoryLimitGiB"
  | "workspaceGiB";
export type RuntimeTierFormErrors = Partial<
  Record<RuntimeTierFormField, string>
>;

/** A tier the administrator saves, without the rename marker. */
export type RuntimeTierInput = Omit<
  AgentRuntimeTierDefinitionInput,
  "previousName"
>;

const CPU_DECIMALS = 1000;

/** A readable creation default that cannot collide with an existing tier. */
export function suggestRuntimeTierName(
  existingNames: readonly string[],
): string {
  const adjectives = ["Brisk", "Calm", "Bright", "Swift", "Quiet", "Sunny"];
  const nouns = ["Cedar", "Falcon", "Maple", "Otter", "Pine", "Willow"];
  const base = `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
  let name = base;
  let suffix = 2;
  while (
    existingNames.some((existing) => sameAgentRuntimeTierName(existing, name))
  )
    name = `${base} ${suffix++}`;
  return name;
}

/** The form for a tier being edited, or an empty one for a new tier. */
export function runtimeTierFormValues(
  tier: RuntimeTierSize | null,
  isDefault: boolean,
): RuntimeTierFormValues {
  return tier
    ? {
        name: tier.name,
        cpuRequest: String(tier.cpuRequest),
        cpuLimit: tier.cpuLimit === null ? "" : String(tier.cpuLimit),
        memoryRequestGiB:
          tier.memoryRequestMiBOverride === undefined
            ? ""
            : String(tier.memoryRequestMiBOverride / 1024),
        memoryLimitGiB:
          tier.memoryLimitMiBOverride === undefined
            ? ""
            : String(tier.memoryLimitMiBOverride / 1024),
        workspaceGiB:
          tier.workspaceGiB === null ? "" : String(tier.workspaceGiB),
        pooled: tier.pooled,
        isDefault,
      }
    : {
        name: "",
        cpuRequest: "",
        cpuLimit: "",
        memoryRequestGiB: "",
        memoryLimitGiB: "",
        workspaceGiB: "",
        pooled: true,
        isDefault,
      };
}

/** A number typed into a field, or null when the text is not one. */
function parseNumberField(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/** Effective memory from the typed CPU and any explicit memory amounts. */
export function runtimeTierFormMemory(
  values: Pick<RuntimeTierFormValues, "cpuRequest" | "cpuLimit"> &
    Partial<Pick<RuntimeTierFormValues, "memoryRequestGiB" | "memoryLimitGiB">>,
): { memoryRequestMiB: number; memoryLimitMiB: number } | null {
  const cpuRequest = parseNumberField(values.cpuRequest);
  if (cpuRequest === null || cpuRequest <= 0) return null;
  const cpuLimit = parseNumberField(values.cpuLimit);
  const derived = agentRuntimeTierMemory({
    cpuRequest,
    cpuLimit: cpuLimit !== null && cpuLimit > 0 ? cpuLimit : null,
    memoryRequestMiB: memoryMiBFromGiBField(values.memoryRequestGiB ?? ""),
  });
  return {
    memoryRequestMiB: derived.memoryRequestMiB,
    memoryLimitMiB:
      memoryMiBFromGiBField(values.memoryLimitGiB ?? "") ??
      derived.memoryLimitMiB,
  };
}

/**
 * What the form would save, or what stops it, field by field: a missing or
 * taken name, a CPU amount outside its range or below the request, a
 * workspace size that is not whole GiB in range.
 */
export function validateRuntimeTierForm(
  values: RuntimeTierFormValues,
  params: { otherNames: readonly string[] },
): { errors: RuntimeTierFormErrors; tier: RuntimeTierInput | null } {
  const errors: RuntimeTierFormErrors = {};
  const name = values.name.trim();
  if (!name) errors.name = "Enter a name";
  else if (name.length > AGENT_RUNTIME_TIER_NAME_MAX_LENGTH)
    errors.name = `At most ${AGENT_RUNTIME_TIER_NAME_MAX_LENGTH} characters`;
  else if (
    params.otherNames.some((other) => sameAgentRuntimeTierName(other, name))
  )
    errors.name = `Another tier is named ${name}`;

  const cpuRequest = parseNumberField(values.cpuRequest);
  if (
    cpuRequest === null ||
    cpuRequest < AGENT_RUNTIME_TIER_MIN_CPU ||
    cpuRequest > AGENT_RUNTIME_TIER_MAX_CPU_REQUEST
  )
    errors.cpuRequest = `Enter a number from ${AGENT_RUNTIME_TIER_MIN_CPU} to ${AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}`;
  else if (cpuRequest !== Math.round(cpuRequest * CPU_DECIMALS) / CPU_DECIMALS)
    errors.cpuRequest = "At most three decimals";

  const cpuLimit = values.cpuLimit.trim()
    ? parseNumberField(values.cpuLimit)
    : null;
  if (values.cpuLimit.trim()) {
    if (
      cpuLimit === null ||
      cpuLimit < AGENT_RUNTIME_TIER_MIN_CPU ||
      cpuLimit > AGENT_RUNTIME_TIER_MAX_CPU_LIMIT
    )
      errors.cpuLimit = `Enter a number from ${AGENT_RUNTIME_TIER_MIN_CPU} to ${AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}, or leave it blank for no limit`;
    else if (cpuLimit !== Math.round(cpuLimit * CPU_DECIMALS) / CPU_DECIMALS)
      errors.cpuLimit = "At most three decimals";
    else if (cpuRequest !== null && !errors.cpuRequest && cpuLimit < cpuRequest)
      errors.cpuLimit = "The CPU limit is below the CPU request";
  }

  const workspaceGiB = values.workspaceGiB.trim()
    ? parseNumberField(values.workspaceGiB)
    : null;
  if (
    values.workspaceGiB.trim() &&
    !AgentRuntimeWorkspaceGiBSchema.safeParse(workspaceGiB).success
  )
    errors.workspaceGiB =
      "Enter a positive whole number, or leave it blank for the default";

  const memoryRequestMiB = memoryMiBFromGiBField(values.memoryRequestGiB);
  const memoryLimitMiB = memoryMiBFromGiBField(values.memoryLimitGiB);
  for (const field of ["memoryRequestGiB", "memoryLimitGiB"] as const) {
    if (
      values[field].trim() &&
      !AgentRuntimeMemoryMiBSchema.safeParse(
        memoryMiBFromGiBField(values[field]),
      ).success
    )
      errors[field] =
        "Enter a positive memory amount, or leave it blank for the default";
  }
  const memory = runtimeTierFormMemory(values);
  if (
    memory &&
    !errors.cpuRequest &&
    !errors.cpuLimit &&
    !errors.memoryRequestGiB &&
    !errors.memoryLimitGiB
  ) {
    if (!AgentRuntimeMemoryMiBSchema.safeParse(memory.memoryLimitMiB).success)
      errors.memoryLimitGiB =
        "Enter an explicit memory limit; the default exceeds the supported numeric range";
    else if (memory.memoryLimitMiB < memory.memoryRequestMiB)
      errors.memoryLimitGiB = "The memory limit is below the memory request";
  }

  if (Object.keys(errors).length > 0 || cpuRequest === null)
    return { errors, tier: null };
  return {
    errors,
    tier: {
      name,
      cpuRequest,
      cpuLimit,
      memoryRequestMiB,
      memoryLimitMiB,
      pooled: values.pooled,
      workspaceGiB,
    },
  };
}

type RuntimeTierChange =
  | { kind: "create"; tier: RuntimeTierInput; isDefault: boolean }
  | {
      kind: "update";
      original: string;
      tier: RuntimeTierInput;
      isDefault: boolean;
    }
  | { kind: "delete"; name: string };

/**
 * The whole list as the API saves it, after one change. A renamed tier
 * carries its previous name so agents and templates follow; the default
 * follows a rename of the default tier.
 */
export function runtimeTierSettingsAfter(
  current: RuntimeTiersInEffect,
  change: RuntimeTierChange,
): AgentRuntimeTierSettingsInput {
  const base = current.tiers.map(
    ({
      name,
      cpuRequest,
      cpuLimit,
      pooled,
      workspaceGiB,
      memoryRequestMiBOverride,
      memoryLimitMiBOverride,
    }): AgentRuntimeTierDefinitionInput => ({
      name,
      cpuRequest,
      cpuLimit,
      pooled,
      workspaceGiB,
      ...(memoryRequestMiBOverride === undefined
        ? {}
        : { memoryRequestMiB: memoryRequestMiBOverride }),
      ...(memoryLimitMiBOverride === undefined
        ? {}
        : { memoryLimitMiB: memoryLimitMiBOverride }),
    }),
  );
  switch (change.kind) {
    case "create":
      return {
        tiers: [...base, change.tier],
        defaultTier: change.isDefault ? change.tier.name : current.defaultTier,
      };
    case "update": {
      const renamed = !sameAgentRuntimeTierName(
        change.original,
        change.tier.name,
      );
      const wasDefault = sameAgentRuntimeTierName(
        change.original,
        current.defaultTier,
      );
      return {
        tiers: base.map((tier) =>
          sameAgentRuntimeTierName(tier.name, change.original)
            ? {
                ...change.tier,
                ...(renamed ? { previousName: change.original } : {}),
              }
            : tier,
        ),
        defaultTier:
          change.isDefault || wasDefault
            ? change.tier.name
            : current.defaultTier,
      };
    }
    case "delete":
      return {
        tiers: base.filter(
          (tier) => !sameAgentRuntimeTierName(tier.name, change.name),
        ),
        defaultTier: current.defaultTier,
      };
  }
}

/** Convert GiB to the API's whole MiB, rounding to the nearest MiB. */
function memoryMiBFromGiBField(text: string): number | null {
  const gib = parseNumberField(text);
  return gib === null ? null : Math.round(gib * 1024);
}
