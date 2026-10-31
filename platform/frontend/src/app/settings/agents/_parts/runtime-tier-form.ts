import {
  AGENT_RUNTIME_TIER_MAX_CPU_LIMIT,
  AGENT_RUNTIME_TIER_MAX_CPU_REQUEST,
  AGENT_RUNTIME_TIER_MAX_WORKSPACE_GIB,
  AGENT_RUNTIME_TIER_NAME_MAX_LENGTH,
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
  /** Blank keeps the deployment's default. */
  workspaceGiB: string;
  pooled: boolean;
  isDefault: boolean;
}

export type RuntimeTierFormField =
  | "name"
  | "cpuRequest"
  | "cpuLimit"
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
        workspaceGiB:
          tier.workspaceGiB === null ? "" : String(tier.workspaceGiB),
        pooled: tier.pooled,
        isDefault,
      }
    : {
        name: "",
        cpuRequest: "",
        cpuLimit: "",
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

/** The memory the typed CPU gives the tier, once the request is a number. */
export function runtimeTierFormMemory(
  values: Pick<RuntimeTierFormValues, "cpuRequest" | "cpuLimit">,
): { memoryRequestMiB: number; memoryLimitMiB: number } | null {
  const cpuRequest = parseNumberField(values.cpuRequest);
  if (cpuRequest === null || cpuRequest <= 0) return null;
  const cpuLimit = parseNumberField(values.cpuLimit);
  return agentRuntimeTierMemory(
    cpuRequest,
    cpuLimit !== null && cpuLimit > 0 ? cpuLimit : null,
  );
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
    cpuRequest <= 0 ||
    cpuRequest > AGENT_RUNTIME_TIER_MAX_CPU_REQUEST
  )
    errors.cpuRequest = `Enter a number from 0.1 to ${AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}`;
  else if (!Number.isInteger(cpuRequest * CPU_DECIMALS))
    errors.cpuRequest = "At most three decimals";

  const cpuLimit = values.cpuLimit.trim()
    ? parseNumberField(values.cpuLimit)
    : null;
  if (values.cpuLimit.trim()) {
    if (
      cpuLimit === null ||
      cpuLimit <= 0 ||
      cpuLimit > AGENT_RUNTIME_TIER_MAX_CPU_LIMIT
    )
      errors.cpuLimit = `Enter a number up to ${AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}, or leave it blank for no limit`;
    else if (!Number.isInteger(cpuLimit * CPU_DECIMALS))
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
    errors.workspaceGiB = `Enter a whole number from 1 to ${AGENT_RUNTIME_TIER_MAX_WORKSPACE_GIB}, or leave it blank for the default`;

  if (Object.keys(errors).length > 0 || cpuRequest === null)
    return { errors, tier: null };
  return {
    errors,
    tier: { name, cpuRequest, cpuLimit, pooled: values.pooled, workspaceGiB },
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
    }): AgentRuntimeTierDefinitionInput => ({
      name,
      cpuRequest,
      cpuLimit,
      pooled,
      workspaceGiB,
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
