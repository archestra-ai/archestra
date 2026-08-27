import {
  AgentExcludedConnectorModel,
  AgentVersionModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import type { AgentKnowledgeSourceExclusions } from "@/types";

/**
 * Orchestration for per-agent Auto-mode knowledge-source exclusions: the
 * knowledge connectors removed from the surface `query_knowledge_sources`
 * spans while the agent's "access all tools" setting is on. The knowledge
 * analog of {@link agentToolExclusionsService}, and as simple as the subagent
 * one — an exclusion is just a connector id, with no cross-identity matching
 * and no built-in prefill.
 */
class AgentKnowledgeSourceExclusionsService {
  async getExclusions(
    agentId: string,
  ): Promise<AgentKnowledgeSourceExclusions> {
    const excludedConnectorIds =
      await AgentExcludedConnectorModel.findConnectorIdsByAgent(agentId);
    return { excludedConnectorIds };
  }

  /**
   * Full replace of the agent's excluded knowledge-source set. Silently drops
   * ids that are not live connectors in the same organization (stale UI state,
   * or a connector deleted between fetch and save) so a replace never fails on
   * drift and never stores a cross-tenant reference. Returns the persisted set.
   */
  async replaceExclusions(params: {
    agentId: string;
    organizationId: string;
    excludedConnectorIds: string[];
    /** See `AgentToolAssignmentRequest.deferVersionFork`. */
    deferVersionFork?: boolean;
  }): Promise<AgentKnowledgeSourceExclusions> {
    const { agentId, organizationId, excludedConnectorIds } = params;

    const requested = [...new Set(excludedConnectorIds)];
    const connectors = await KnowledgeBaseConnectorModel.findByIds(requested);
    const sameOrg = new Set(
      connectors
        .filter((connector) => connector.organizationId === organizationId)
        .map((connector) => connector.id),
    );
    const valid = requested.filter((id) => sameOrg.has(id));

    await AgentExcludedConnectorModel.replaceForAgent(agentId, valid);

    // The excluded-knowledge-source set is part of the config snapshot — fork
    // a version.
    if (!params.deferVersionFork) {
      await AgentVersionModel.forkIfChangedBestEffort(agentId);
    }

    return this.getExclusions(agentId);
  }
}

export const agentKnowledgeSourceExclusionsService =
  new AgentKnowledgeSourceExclusionsService();
