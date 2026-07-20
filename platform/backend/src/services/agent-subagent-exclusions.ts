import { AgentExcludedSubagentModel, AgentModel } from "@/models";
import type { AgentSubagentExclusions } from "@/types";

/**
 * Orchestration for per-agent Auto-subagent-mode exclusions: the delegation
 * targets removed from an agent's Auto delegation surface. The subagent analog
 * of {@link agentToolExclusionsService}, but far simpler — an exclusion is just
 * a target agent id, so there is no cross-identity matching or built-in prefill.
 */
class AgentSubagentExclusionsService {
  async getExclusions(agentId: string): Promise<AgentSubagentExclusions> {
    const excludedSubagentIds =
      await AgentExcludedSubagentModel.findTargetAgentIdsByAgent(agentId);
    return { excludedSubagentIds };
  }

  /**
   * Full replace of the agent's excluded delegation-target set. Silently drops
   * ids that are not agents in the same organization (stale UI state, or an
   * agent deleted between fetch and save) so a replace never fails on drift and
   * never stores a cross-tenant reference. Returns the persisted set.
   */
  async replaceExclusions(params: {
    agentId: string;
    organizationId: string;
    excludedSubagentIds: string[];
  }): Promise<AgentSubagentExclusions> {
    const { agentId, organizationId, excludedSubagentIds } = params;

    const requested = new Set(excludedSubagentIds);
    const orgAgentIds = new Set(
      await AgentModel.findIdsByOrganizationId(organizationId),
    );
    // Keep only real, same-org targets, and never exclude the agent from itself.
    const valid = [...requested].filter(
      (id) => id !== agentId && orgAgentIds.has(id),
    );

    await AgentExcludedSubagentModel.replaceForAgent(agentId, valid);

    return this.getExclusions(agentId);
  }
}

export const agentSubagentExclusionsService =
  new AgentSubagentExclusionsService();
