import { z } from "zod";
export const DiscoverOpenAppaScenariosSchema = z.strictObject({});
export const SelectOpenAppaScenarioSchema = z.strictObject({
  discoveryId: z.string().uuid(),
  candidateId: z.string().min(1).max(80),
});
const OpenAppaScenarioDiscoverySchema = z.object({
  discoveryId: z.string().uuid(),
  status: z.enum(["ready", "setup_required", "unavailable"]),
  message: z.string(),
  scope: z.string(),
  evaluated: z.number().int().nonnegative(),
  limited: z.boolean(),
  candidates: z.array(
    z.object({
      id: z.string(),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()),
      decision: z.enum(["allow", "deny"]),
      content: z.string(),
      existingFiles: z.array(z.string()),
    }),
  ),
  unavailable: z.array(
    z.object({
      tool: z.string(),
      kind: z.enum(["needs_input", "cannot_run"]),
      reason: z.string(),
    }),
  ),
});
export type OpenAppaScenarioDiscovery = z.infer<
  typeof OpenAppaScenarioDiscoverySchema
>;
