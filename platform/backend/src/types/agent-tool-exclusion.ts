import { z } from "zod";
import { UuidIdSchema } from "./api";

/**
 * API shape of an agent's Auto-tool-mode exclusions: individually excluded
 * tools. Used as both the GET response and the PUT body (full replace) of
 * /api/agents/:id/tool-exclusions.
 */
export const AgentToolExclusionsSchema = z.object({
  excludedToolIds: z
    .array(UuidIdSchema)
    .describe("Individual tool IDs excluded from the agent's surface"),
});

export type AgentToolExclusions = z.infer<typeof AgentToolExclusionsSchema>;
