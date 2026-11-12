import {
  AgentExcludedSubagentModel,
  AgentModel,
  AgentVersionModel,
} from "@/models";
import { ResourcePermissions } from "@/services/resource-permissions";
import type { Agent, AgentSubagentExclusions } from "@/types";
import { isUuid } from "@/utils/uuid";

/**
 * Resolve all runtime subagent IDs eligible for pool routing on `callerAgent`.
 *
 * Supports both "All agents" (`accessAllSubagents: true`, excluding
 * `agent_excluded_subagents`) and "Manual" (`accessAllSubagents: false`,
 * explicit `delegateToAgentId` assignments).
 */
export async function resolveCandidateRuntimeSubagentIds(params: {
  callerAgent: Pick<
    Agent,
    "id" | "organizationId" | "environmentId" | "accessAllSubagents"
  >;
  actorUserId?: string | null;
}): Promise<string[]> {
  const { callerAgent, actorUserId } = params;
  if (
    callerAgent.accessAllSubagents &&
    actorUserId &&
    actorUserId !== "system"
  ) {
    const isAgentAdmin = await ResourcePermissions.allows({
      userId: actorUserId,
      organizationId: callerAgent.organizationId,
      resource: "agent",
      scope: "*",
      action: "update",
    });
    const [targets, excludedIds] = await Promise.all([
      AgentModel.findAccessibleDelegationTargets({
        userId: actorUserId,
        isAdmin: isAgentAdmin,
        organizationId: callerAgent.organizationId,
        excludeAgentId: callerAgent.id,
        includeDetails: false,
        environmentId: callerAgent.environmentId,
      }),
      AgentExcludedSubagentModel.findTargetAgentIdsByAgent(callerAgent.id),
    ]);
    const excluded = new Set(excludedIds);
    return targets
      .filter((target) => target.hasRuntime && !excluded.has(target.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((target) => target.id);
  }
  return AgentModel.findAssignedRuntimeSubagentIds(
    callerAgent.id,
    callerAgent.environmentId,
  );
}

/**
 * Whether `callerAgentId` in `organizationId` has at least one candidate runtime
 * subagent when `start_agent_run` omits `agent_id`.
 */
export async function callerHasCandidateRuntimeSubagents(params: {
  callerAgentId: string;
  organizationId: string;
  actorUserId?: string | null;
}): Promise<boolean> {
  if (!isUuid(params.callerAgentId)) {
    return false;
  }
  const callerAgent = await AgentModel.findById(params.callerAgentId);
  if (!callerAgent || callerAgent.organizationId !== params.organizationId) {
    return false;
  }
  const candidates = await resolveCandidateRuntimeSubagentIds({
    callerAgent,
    actorUserId: params.actorUserId,
  });
  return candidates.length > 0;
}

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
