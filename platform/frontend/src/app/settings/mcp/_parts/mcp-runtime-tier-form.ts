import type {
  McpRuntimeTierSettingsInput,
  McpRuntimeTierSize,
} from "@archestra/shared";

/** Preserve stored overrides, not the resolved memory displayed in the table. */
export function mcpRuntimeTierInput(
  tier: McpRuntimeTierSize,
): McpRuntimeTierSettingsInput["tiers"][number] {
  return {
    name: tier.name,
    cpuRequest: tier.cpuRequest,
    cpuLimit: tier.cpuLimit,
    memoryRequestMiB: tier.memoryRequestMiBOverride ?? null,
    memoryLimitMiB: tier.memoryLimitMiBOverride ?? null,
  };
}
