import {
  ARCHESTRA_MCP_CATALOG_ID,
  type PaginationQuery,
  TOOL_LOAD_SKILL_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { createPaginatedResult } from "@/database/utils/pagination";
import {
  getAvailableAgentSkillReference,
  listPolicyIndependentAvailableAgentSkills,
  type PolicyIndependentAvailableAgentSkill,
  type SkillAvailabilityContext,
} from "@/services/agent-activation-skill-candidates";
import {
  type AgentActivationSkillPolicyEvaluator,
  agentActivationSkillPolicyService,
} from "@/services/agent-activation-skill-policy";
import {
  type ProjectedExternalSkill,
  type ProjectedPluginSkill,
  projectLiveSkillNames,
  toAgentActivationSkill,
} from "@/services/agent-activation-skill-projection";
import {
  agentToolExclusionsService,
  isToolIdentityExcluded,
  isToolRowExcluded,
} from "@/services/agent-tool-exclusions";
import type {
  Agent,
  AgentActivationSkill,
  AgentActivationSkillsResponse,
  PaginatedAgentActivationSkillsResponse,
  Skill,
} from "@/types";

export {
  type ProjectedExternalSkill,
  type ProjectedPluginSkill,
  projectPolicyIndependentAvailableAgentSkills,
} from "@/services/agent-activation-skill-projection";

export type AvailableAgentSkill =
  | { source: "native"; activationName: string; skill: Skill }
  | ProjectedPluginSkill
  | ProjectedExternalSkill;

/**
 * The structured counterpart to `list_skills`: the skill sources visible to
 * the current principal in an agent's environment and allowed by that agent's
 * policy, with the same projected activation names the MCP tool accepts.
 */
export async function listAvailableAgentSkills(
  params: SkillAvailabilityContext,
): Promise<AvailableAgentSkill[]> {
  const candidates = await listPolicyIndependentAvailableAgentSkills(params);
  const policyEvaluator =
    params.agentId === undefined
      ? null
      : await agentActivationSkillPolicyService.getEvaluator(params.agentId);
  return projectEffectiveAvailableAgentSkills(
    candidates,
    params.userId,
    policyEvaluator,
  );
}

/** Apply one agent policy and the same precedence/name projection as runtime. */
export function projectEffectiveAvailableAgentSkills(
  candidates: PolicyIndependentAvailableAgentSkill[],
  userId: string | undefined,
  policyEvaluator: AgentActivationSkillPolicyEvaluator | null,
): AvailableAgentSkill[] {
  const nativeSkills = candidates
    .filter((candidate) => candidate.source === "native")
    .map((candidate) => candidate.skill);
  const pluginSkills = candidates
    .filter((candidate) => candidate.source === "plugin")
    .map((candidate) => candidate.skill);
  const externalSkills = candidates
    .filter((candidate) => candidate.source === "external")
    .map((candidate) => candidate.skill);
  const policyNativeSkills = policyEvaluator
    ? nativeSkills.filter((skill) =>
        policyEvaluator.isReferenceAllowed({
          source: "native",
          skillId: skill.id,
        }),
      )
    : nativeSkills;
  const projectedSkills = projectLiveSkillNames({
    nativeNames: nativeSkills.map((skill) => skill.name),
    pluginSkills,
    externalSkills,
  });
  const effectiveNativeSkills = selectEffectiveNativeSkills(
    policyNativeSkills,
    userId,
  );
  return [
    ...effectiveNativeSkills.map((skill) => ({
      source: "native" as const,
      activationName: skill.name,
      skill,
    })),
    ...projectedSkills.filter((available) =>
      policyEvaluator
        ? policyEvaluator.isReferenceAllowed(
            getAvailableAgentSkillReference(available),
          )
        : true,
    ),
  ];
}

export async function getAgentActivationSkills(
  params: SkillAvailabilityContext & { enabled: boolean },
): Promise<AgentActivationSkillsResponse> {
  if (!params.enabled) return { enabled: false, skills: [] };

  const skills = (await listAvailableAgentSkills(params))
    .map(toAgentActivationSkill)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        referenceKey(left).localeCompare(referenceKey(right)),
    );
  return { enabled: true, skills };
}

/**
 * HTTP list projection of the effective activation catalog. Search is a
 * case-insensitive substring match across display name, activation name,
 * description, and provider name, and is applied before offset pagination.
 */
export async function getPaginatedAgentActivationSkills(
  params: SkillAvailabilityContext & {
    enabled: boolean;
    pagination: PaginationQuery;
    search?: string;
  },
): Promise<PaginatedAgentActivationSkillsResponse> {
  const catalog = await getAgentActivationSkills(params);
  const normalizedSearch = params.search?.trim().toLowerCase();
  const filteredSkills = normalizedSearch
    ? catalog.skills.filter((skill) =>
        [
          skill.name,
          skill.activationName,
          skill.description,
          skill.providerName,
        ].some((field) => field?.toLowerCase().includes(normalizedSearch)),
      )
    : catalog.skills;
  const { limit, offset } = params.pagination;

  return {
    enabled: catalog.enabled,
    ...createPaginatedResult(
      filteredSkills.slice(offset, offset + limit),
      filteredSkills.length,
      params.pagination,
    ),
  };
}

/**
 * Batched `load_skill` availability for agent-card projections. The list query
 * already attached every explicit assignment; this adds one exclusion read
 * for all Auto agents and applies the same assignment/exclusion/Auto rules as
 * runtime execution without reloading each agent's tools.
 */
export async function getAgentSkillActivationAvailability(params: {
  agents: Agent[];
  userId?: string;
}): Promise<Map<string, boolean>> {
  const toolName = archestraMcpBranding.getToolName(TOOL_LOAD_SKILL_SHORT_NAME);
  const exclusionSetsByAgent =
    await agentToolExclusionsService.getActiveExclusionSetsForAgents(
      params.agents,
    );

  return new Map(
    params.agents.map((agent) => {
      const exclusionSets = exclusionSetsByAgent.get(agent.id);
      if (!exclusionSets) return [agent.id, false] as const;
      const explicitlyAssigned = agent.tools.some(
        (tool) =>
          archestraMcpBranding.getToolShortName(tool.name) ===
            TOOL_LOAD_SKILL_SHORT_NAME &&
          !isToolRowExcluded(tool, exclusionSets),
      );
      const dynamicallyAvailable =
        agent.accessAllTools &&
        params.userId !== undefined &&
        params.userId !== "system" &&
        !isToolIdentityExcluded(
          { catalogId: ARCHESTRA_MCP_CATALOG_ID, name: toolName },
          exclusionSets,
        );
      return [agent.id, explicitlyAssigned || dynamicallyAvailable] as const;
    }),
  );
}

export function selectEffectiveNativeSkills(
  skills: Skill[],
  userId: string | undefined,
): Skill[] {
  const effective = new Map<string, Skill>();
  for (const skill of skills) {
    const current = effective.get(skill.name);
    if (
      !current ||
      nativeSkillPrecedence(skill, userId) <
        nativeSkillPrecedence(current, userId) ||
      (nativeSkillPrecedence(skill, userId) ===
        nativeSkillPrecedence(current, userId) &&
        compareNativeSkillRecency(skill, current) < 0)
    ) {
      effective.set(skill.name, skill);
    }
  }
  return Array.from(effective.values());
}

/**
 * Match `SkillModel.findAllByName`'s newest-first tie break after applying the
 * caller-relative scope precedence. Sharing this selector with `load_skill`
 * keeps the catalog row and the skill that actually loads identical.
 */
function compareNativeSkillRecency(left: Skill, right: Skill): number {
  const createdAt = right.createdAt.getTime() - left.createdAt.getTime();
  return createdAt || right.id.localeCompare(left.id);
}

function nativeSkillPrecedence(skill: Skill, userId: string | undefined) {
  switch (skill.scope) {
    case "personal":
      return skill.authorId === userId ? 0 : 3;
    case "team":
      return 1;
    case "org":
      return 2;
  }
}

function referenceKey(skill: AgentActivationSkill): string {
  const reference = skill.reference;
  switch (reference.source) {
    case "native":
      return `native:${reference.skillId}`;
    case "external_mcp":
      return `external:${reference.mcpServerId}:${reference.uri}`;
    case "plugin":
      return `plugin:${reference.pluginId}:${reference.skillPath}`;
  }
}
