import {
  AGENT_RUNTIME_TIER_MAX_WARM_POOL_SIZE,
  AGENT_RUNTIME_TIERS,
  type AgentRuntimeTierName,
  type AgentRuntimeTierSettings,
  AgentRuntimeTierSettingsSchema,
  agentRuntimeTierProblems,
  isValidK8sCpuQuantity,
  isValidK8sMemoryQuantity,
  resolveAgentRuntimeTiers,
} from "@archestra/shared";

export const RUNTIME_TIER_FIELDS = [
  "cpuRequest",
  "cpuLimit",
  "memoryRequest",
  "memoryLimit",
  "warmPoolSize",
] as const;
type RuntimeTierField = (typeof RUNTIME_TIER_FIELDS)[number];

export const RUNTIME_TIER_FIELD_LABELS: Record<RuntimeTierField, string> = {
  cpuRequest: "CPU request",
  cpuLimit: "CPU limit",
  memoryRequest: "Memory request",
  memoryLimit: "Memory limit",
  warmPoolSize: "Warm spares",
};

const FIELD_CHECKS: Record<
  RuntimeTierField,
  { valid: (text: string) => boolean; hint: string }
> = {
  cpuRequest: {
    valid: isValidK8sCpuQuantity,
    hint: "a CPU amount such as 2 or 500m",
  },
  cpuLimit: {
    valid: isValidK8sCpuQuantity,
    hint: "a CPU amount such as 2 or 500m",
  },
  memoryRequest: {
    valid: isValidK8sMemoryQuantity,
    hint: "a memory amount such as 4Gi",
  },
  memoryLimit: {
    valid: isValidK8sMemoryQuantity,
    hint: "a memory amount such as 4Gi",
  },
  warmPoolSize: {
    valid: (text) =>
      /^\d+$/.test(text) &&
      Number(text) <= AGENT_RUNTIME_TIER_MAX_WARM_POOL_SIZE,
    hint: `a whole number from 0 to ${AGENT_RUNTIME_TIER_MAX_WARM_POOL_SIZE}`,
  },
};

/** The form's text per tier and field; an empty string keeps the default. */
export type RuntimeTierDraft = Record<
  AgentRuntimeTierName,
  Record<RuntimeTierField, string>
>;

export function runtimeTierDraft(
  settings: Partial<Record<string, Record<string, unknown>>> | null | undefined,
): RuntimeTierDraft {
  return Object.fromEntries(
    AGENT_RUNTIME_TIERS.map((tier) => [
      tier,
      Object.fromEntries(
        RUNTIME_TIER_FIELDS.map((field) => {
          const value = settings?.[tier]?.[field];
          return [
            field,
            typeof value === "string" || typeof value === "number"
              ? String(value)
              : "",
          ];
        }),
      ),
    ]),
  ) as RuntimeTierDraft;
}

/** What the form would store: only the fields an administrator filled in. */
export function runtimeTierSettings(
  draft: RuntimeTierDraft,
): Record<string, Record<string, unknown>> | null {
  const settings: Record<string, Record<string, unknown>> = {};
  for (const tier of AGENT_RUNTIME_TIERS) {
    const fields: Record<string, unknown> = {};
    for (const field of RUNTIME_TIER_FIELDS) {
      const text = draft[tier][field].trim();
      if (!text) continue;
      fields[field] =
        field === "warmPoolSize" && /^\d+$/.test(text) ? Number(text) : text;
    }
    if (Object.keys(fields).length) settings[tier] = fields;
  }
  return Object.keys(settings).length ? settings : null;
}

/**
 * The stored value for a valid draft, or the problems that stop a save: a
 * field that is not a Kubernetes quantity, a limit below its request, or
 * tiers out of order.
 */
export function validateRuntimeTierDraft(
  draft: RuntimeTierDraft,
):
  | { ok: true; settings: AgentRuntimeTierSettings | null }
  | { ok: false; problems: string[] } {
  const problems: string[] = [];
  for (const tier of AGENT_RUNTIME_TIERS)
    for (const field of RUNTIME_TIER_FIELDS) {
      const text = draft[tier][field].trim();
      if (text && !FIELD_CHECKS[field].valid(text))
        problems.push(
          `Tier ${tier} ${RUNTIME_TIER_FIELD_LABELS[field]}: enter ${FIELD_CHECKS[field].hint}`,
        );
    }
  if (problems.length) return { ok: false, problems };
  const settings = AgentRuntimeTierSettingsSchema.nullable().parse(
    runtimeTierSettings(draft),
  );
  const tierProblems = agentRuntimeTierProblems(
    resolveAgentRuntimeTiers(settings),
  );
  return tierProblems.length
    ? { ok: false, problems: tierProblems }
    : { ok: true, settings };
}

export function runtimeTierDraftChanged(
  draft: RuntimeTierDraft,
  saved: RuntimeTierDraft,
): boolean {
  return AGENT_RUNTIME_TIERS.some((tier) =>
    RUNTIME_TIER_FIELDS.some(
      (field) => draft[tier][field].trim() !== saved[tier][field].trim(),
    ),
  );
}
