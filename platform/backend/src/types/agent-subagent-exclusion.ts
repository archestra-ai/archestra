import { z } from "zod";
import { UuidIdSchema } from "./api";

/**
 * API shape of an agent's Auto-subagent-mode exclusions: individually excluded
 * delegation target agents. Used as both the GET response and the PUT body
 * (full replace) of /api/agents/:id/subagent-exclusions.
 */
export const AgentSubagentExclusionsSchema = z.object({
  excludedSubagentIds: z
    .array(UuidIdSchema)
    .describe(
      "Target agent IDs excluded from the agent's Auto delegation surface",
    ),
});

export type AgentSubagentExclusions = z.infer<
  typeof AgentSubagentExclusionsSchema
>;
