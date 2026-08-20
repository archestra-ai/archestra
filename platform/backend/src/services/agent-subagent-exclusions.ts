import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import {
  AgentExcludedSubagentModel,
  AgentModel,
  AgentVersionModel,
} from "@/models";
import type { AgentSubagentExclusions, AgentType } from "@/types";

/**
 * Agent types that can delegate at all. An llm_proxy has no delegation
 * surface, so seeding it an exclusion would record a preference about
 * something it can never do.
 */
const DELEGATING_AGENT_TYPES: ReadonlySet<AgentType> = new Set<AgentType>([
  "agent",
  "mcp_gateway",
  "profile",
]);

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
   * The exclusions a record starts life with, decided server-side and passed
   * to `AgentModel.create` so version 1 already carries them.
   *
   * Consulting the Advisor is opt-in: a new agent in Auto subagent mode would
   * otherwise reach it the moment it exists, so the Advisor starts excluded
   * and the switch's "off" is true rather than decorative. Empty for anything
   * that cannot delegate, for Custom subagent mode (where nothing is reachable
   * unless explicitly assigned, so an exclusion says nothing), and for an
   * organization with no Advisor row — a missing built-in is not an error.
   *
   * Built-ins are seeded, never created through the paths that call this:
   * `builtInAgentConfig` is server-owned, forced to null by the REST create
   * route and never set by the MCP create tool, so no built-in check belongs
   * here.
   */
  async getCreationDefaultExclusions(params: {
    organizationId: string;
    agentType: AgentType;
    accessAllSubagents: boolean;
  }): Promise<string[]> {
    const { organizationId, agentType, accessAllSubagents } = params;

    if (!accessAllSubagents || !DELEGATING_AGENT_TYPES.has(agentType)) {
      return [];
    }

    const advisor = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.ADVISOR,
      organizationId,
    );
    return advisor ? [advisor.id] : [];
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
    /** See `AgentToolAssignmentRequest.deferVersionFork`. */
    deferVersionFork?: boolean;
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

    // Excluded-subagent set is part of the config snapshot — fork a version.
    if (!params.deferVersionFork) {
      await AgentVersionModel.forkIfChangedBestEffort(agentId);
    }

    return this.getExclusions(agentId);
  }
}

export const agentSubagentExclusionsService =
  new AgentSubagentExclusionsService();
