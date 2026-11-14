import {
  ARCHESTRA_MCP_CATALOG_ID,
  isPermissionActionGranted,
  normalizeSubagentLoadBalancingConfig,
  TOOL_START_AGENT_RUN_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import type { RequestLookups } from "@/auth/request-lookups";
import { getPermissionsForUserContext } from "@/auth/utils";
import {
  AgentExcludedSubagentModel,
  AgentModel,
  AgentVersionModel,
} from "@/models";
import {
  type AgentToolExclusionSets,
  agentToolExclusionsService,
  isToolIdentityExcluded,
} from "@/services/agent-tool-exclusions";
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
  const realActorUserId =
    actorUserId && actorUserId !== "system" ? actorUserId : null;
  if (callerAgent.accessAllSubagents) {
    if (!realActorUserId) {
      return AgentModel.findAutoRuntimeSubagentIds({
        callerAgentId: callerAgent.id,
        organizationId: callerAgent.organizationId,
        environmentId: callerAgent.environmentId,
      });
    }
    const isAgentAdmin = await ResourcePermissions.allows({
      userId: realActorUserId,
      organizationId: callerAgent.organizationId,
      resource: "agent",
      scope: "*",
      action: "update",
    });
    const [targets, excludedIds] = await Promise.all([
      AgentModel.findAccessibleDelegationTargets({
        userId: realActorUserId,
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
  const assignedIds = await AgentModel.findAssignedRuntimeSubagentIds(
    callerAgent.id,
    callerAgent.environmentId,
  );
  if (assignedIds.length === 0 || !realActorUserId) {
    return assignedIds;
  }
  const isAgentAdmin = await ResourcePermissions.allows({
    userId: realActorUserId,
    organizationId: callerAgent.organizationId,
    resource: "agent",
    scope: "*",
    action: "update",
  });
  if (isAgentAdmin) {
    return assignedIds;
  }
  const accessibleTargets = await AgentModel.findAccessibleDelegationTargets({
    userId: realActorUserId,
    isAdmin: false,
    organizationId: callerAgent.organizationId,
    includeDetails: false,
    environmentId: callerAgent.environmentId,
  });
  const accessibleRuntimeIds = new Set(
    accessibleTargets
      .filter((target) => target.hasRuntime)
      .map((target) => target.id),
  );
  return assignedIds.filter((id) => accessibleRuntimeIds.has(id));
}

/**
 * Whether `callerAgentId` in `organizationId` structurally has at least one
 * candidate runtime subagent when `start_agent_run` omits `agent_id`.
 *
 * Used by OpenAPPA's LLM Proxy spawn classification (`runtimeCalls`) alongside
 * `AgentModel.findRuntimeTargets(organizationId)`: spawn classification is
 * structural (independent of per-user RBAC grants, which `tasks.ts` enforces
 * at tool execution time and reports via `failedLaunch`).
 */
export async function callerHasCandidateRuntimeSubagents(params: {
  callerAgentId: string;
  organizationId: string;
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
  });
  return candidates.length > 0;
}

/**
 * Whether `agent` has subagent load balancing enabled, the acting caller is
 * permitted to invoke `start_agent_run` (`agent:read` on an acting user), does
 * not exclude `start_agent_run` in Auto-tools mode, and resolves at least one
 * candidate runtime subagent — meaning `start_agent_run` is actually exposed
 * and callable as the canonical pooled starter in place of individual
 * `agent__<runtime_worker>` schemas.
 */
export async function callerUsesImplicitLoadBalancedRunStarter(params: {
  agent: Pick<
    Agent,
    | "id"
    | "organizationId"
    | "environmentId"
    | "accessAllTools"
    | "accessAllSubagents"
    | "subagentLoadBalancing"
  >;
  actorUserId?: string | null;
  exclusionSets?: AgentToolExclusionSets;
  lookups?: RequestLookups;
  disallowOAuthApp?: boolean;
  candidateRuntimeSubagentIds?: readonly string[];
}): Promise<boolean> {
  if (
    params.disallowOAuthApp ||
    !params.actorUserId ||
    params.actorUserId === "system" ||
    normalizeSubagentLoadBalancingConfig(params.agent.subagentLoadBalancing)
      ?.enabled !== true
  ) {
    return false;
  }
  const permissions = params.lookups
    ? await params.lookups.permissions({
        userId: params.actorUserId,
        organizationId: params.agent.organizationId,
      })
    : await getPermissionsForUserContext({
        userId: params.actorUserId,
        organizationId: params.agent.organizationId,
      });
  if (
    !isPermissionActionGranted({
      resource: "agent",
      grantedActions: permissions.agent ?? [],
      requiredAction: "read",
    })
  ) {
    return false;
  }
  const exclusionSets =
    params.exclusionSets ??
    (await agentToolExclusionsService.getActiveExclusionSets(params.agent.id, {
      accessAllTools: params.agent.accessAllTools,
    }));
  if (
    isToolIdentityExcluded(
      {
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        name: archestraMcpBranding.getToolName(TOOL_START_AGENT_RUN_SHORT_NAME),
      },
      exclusionSets,
    )
  ) {
    return false;
  }
  const candidates =
    params.candidateRuntimeSubagentIds ??
    (await resolveCandidateRuntimeSubagentIds({
      callerAgent: params.agent,
      actorUserId: params.actorUserId,
    }));
  return candidates.length > 0;
}

/**
 * Resolve the eligible runtime subagent pool for a foreground load-balanced
 * router agent (`routerAgent`) when invoked by `callerAgentId` / `actorUserId`.
 *
 * Returns `[]` when `routerAgent` does not have `subagentLoadBalancing.enabled`
 * or resolves zero non-excluded runtime subagents — matching tool advertisement
 * (`resolveLoadBalancedRouterPools`) so foreground load-balanced agents whose
 * subagents are solely in-process helpers continue executing in-process.
 */
export async function resolveRouterRuntimePoolCandidateIds(params: {
  routerAgent: Pick<
    Agent,
    | "id"
    | "organizationId"
    | "environmentId"
    | "accessAllSubagents"
    | "subagentLoadBalancing"
  >;
  actorUserId?: string | null;
  callerAgentId?: string | null;
}): Promise<string[]> {
  const { routerAgent, actorUserId, callerAgentId } = params;
  if (
    normalizeSubagentLoadBalancingConfig(routerAgent.subagentLoadBalancing)
      ?.enabled !== true
  ) {
    return [];
  }
  const candidateIds = await resolveCandidateRuntimeSubagentIds({
    callerAgent: routerAgent,
    actorUserId,
  });
  if (
    candidateIds.length === 0 ||
    !callerAgentId ||
    callerAgentId === routerAgent.id
  ) {
    return candidateIds;
  }
  const callerExcludedIds =
    await AgentExcludedSubagentModel.findTargetAgentIdsByAgent(callerAgentId);
  if (callerExcludedIds.length === 0) {
    return candidateIds;
  }
  const callerExcludedSet = new Set(callerExcludedIds);
  return candidateIds.filter((id) => !callerExcludedSet.has(id));
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
