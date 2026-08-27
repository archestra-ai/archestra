import { z } from "zod";
import { UuidIdSchema } from "./api";

/**
 * API shape of an agent's Auto-mode knowledge-source exclusions: the knowledge
 * connectors removed from the surface `query_knowledge_sources` spans while
 * "access all tools" is on. A "knowledge source" is a connector — the leaf the
 * agent form lists and the unit the query searches — so the ids are connector
 * ids. Used as both the GET response and the PUT body (full replace) of
 * /api/agents/:id/knowledge-source-exclusions.
 */
export const AgentKnowledgeSourceExclusionsSchema = z.object({
  excludedConnectorIds: z
    .array(UuidIdSchema)
    .describe(
      "Knowledge connector IDs excluded from the agent's Auto knowledge surface",
    ),
});

export type AgentKnowledgeSourceExclusions = z.infer<
  typeof AgentKnowledgeSourceExclusionsSchema
>;
