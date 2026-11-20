import { z } from "zod";
import {
  AGENT_RUNTIME_TIER_MAX_COUNT,
  AgentRuntimeMemoryMiBSchema,
  AgentRuntimeTierDefinitionSchema,
  agentRuntimeTierMemory,
} from "./agent-runtime-tiers";

/** MCP-specific tier definitions. Agent workspace, pools and scaleup never apply. */
export const McpRuntimeTierDefinitionSchema =
  AgentRuntimeTierDefinitionSchema.pick({
    name: true,
    cpuRequest: true,
    cpuLimit: true,
  }).extend({
    memoryRequestMiB: AgentRuntimeMemoryMiBSchema.nullable().optional(),
    memoryLimitMiB: AgentRuntimeMemoryMiBSchema.nullable().optional(),
  });
export type McpRuntimeTierDefinition = z.infer<
  typeof McpRuntimeTierDefinitionSchema
>;
export const McpRuntimeTierSettingsSchema = z
  .strictObject({
    tiers: z
      .array(
        McpRuntimeTierDefinitionSchema.extend({
          previousName: AgentRuntimeTierDefinitionSchema.shape.previousName,
        }),
      )
      .min(1)
      .max(AGENT_RUNTIME_TIER_MAX_COUNT),
  })
  .superRefine(({ tiers }, ctx) => {
    const names = new Set<string>();
    const previousNames = new Set<string>();
    for (const tier of tiers) {
      const name = tier.name.toLowerCase();
      if (names.has(name))
        ctx.addIssue({
          code: "custom",
          message: `Two tiers are named ${tier.name}`,
        });
      names.add(name);
      if (tier.previousName) {
        const previous = tier.previousName.toLowerCase();
        if (previousNames.has(previous))
          ctx.addIssue({
            code: "custom",
            message: `Tier ${tier.previousName} is renamed more than once`,
          });
        previousNames.add(previous);
      }
      if (tier.cpuLimit !== null && tier.cpuLimit < tier.cpuRequest)
        ctx.addIssue({
          code: "custom",
          message: `Tier ${tier.name}: the CPU limit is below the CPU request`,
        });
      if (
        tier.memoryLimitMiB != null &&
        tier.memoryRequestMiB != null &&
        tier.memoryLimitMiB < tier.memoryRequestMiB
      )
        ctx.addIssue({
          code: "custom",
          message: `Tier ${tier.name}: the memory limit is below the memory request`,
        });
    }
  });
export type McpRuntimeTierSettingsInput = z.infer<
  typeof McpRuntimeTierSettingsSchema
>;
export const StoredMcpRuntimeTierSettingsSchema = z.object({
  tiers: z.array(McpRuntimeTierDefinitionSchema),
});
export type McpRuntimeTierSettings = z.infer<
  typeof StoredMcpRuntimeTierSettingsSchema
>;
export const McpRuntimeTierSizeSchema = McpRuntimeTierDefinitionSchema.extend({
  memoryRequestMiB: AgentRuntimeMemoryMiBSchema,
  memoryLimitMiB: AgentRuntimeMemoryMiBSchema,
  memoryRequestMiBOverride: AgentRuntimeMemoryMiBSchema.optional(),
  memoryLimitMiBOverride: AgentRuntimeMemoryMiBSchema.optional(),
});
export type McpRuntimeTierSize = z.infer<typeof McpRuntimeTierSizeSchema>;
export const ResolvedMcpRuntimeTiersSchema = z.object({
  tiers: z.array(McpRuntimeTierSizeSchema),
});
export type ResolvedMcpRuntimeTiers = z.infer<
  typeof ResolvedMcpRuntimeTiersSchema
>;
export const DEFAULT_MCP_RUNTIME_TIERS: McpRuntimeTierSettings = {
  tiers: [
    {
      name: "S",
      cpuRequest: 0.1,
      cpuLimit: null,
      memoryRequestMiB: 128,
      memoryLimitMiB: 512,
    },
    {
      name: "M",
      cpuRequest: 0.5,
      cpuLimit: null,
      memoryRequestMiB: 512,
      memoryLimitMiB: 1024,
    },
    {
      name: "L",
      cpuRequest: 1,
      cpuLimit: null,
      memoryRequestMiB: 1024,
      memoryLimitMiB: 2048,
    },
  ],
};
export function resolveMcpRuntimeTiers(
  settings: McpRuntimeTierSettings | null | undefined,
): ResolvedMcpRuntimeTiers {
  return {
    tiers: (settings ?? DEFAULT_MCP_RUNTIME_TIERS).tiers
      .map((tier) => {
        const derived = agentRuntimeTierMemory(tier);
        return {
          ...tier,
          memoryRequestMiB: derived.memoryRequestMiB,
          memoryLimitMiB: tier.memoryLimitMiB ?? derived.memoryLimitMiB,
          ...(tier.memoryRequestMiB == null
            ? {}
            : { memoryRequestMiBOverride: tier.memoryRequestMiB }),
          ...(tier.memoryLimitMiB == null
            ? {}
            : { memoryLimitMiBOverride: tier.memoryLimitMiB }),
        };
      })
      .sort(
        (a, b) =>
          a.cpuRequest - b.cpuRequest ||
          a.memoryRequestMiB - b.memoryRequestMiB ||
          a.name.localeCompare(b.name),
      ),
  };
}
export function findMcpRuntimeTier<T extends McpRuntimeTierDefinition>(
  tiers: readonly T[],
  name: string | null | undefined,
) {
  return name
    ? tiers.find(
        (tier) => tier.name.toLowerCase() === name.trim().toLowerCase(),
      )
    : undefined;
}
