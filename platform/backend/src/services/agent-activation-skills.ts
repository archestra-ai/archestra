import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_LOAD_SKILL_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { getMcpCatalogPermissionChecker } from "@/auth/mcp-catalog-permissions";
import config from "@/config";
import { AgentModel } from "@/models";
import { listPluginSkills } from "@/plugins/plugin-skills";
import {
  agentToolExclusionsService,
  isToolIdentityExcluded,
  isToolRowExcluded,
} from "@/services/agent-tool-exclusions";
import { listExternalMcpSkills } from "@/services/external-mcp-skills";
import { formatExternalSkillName } from "@/skills/external-skill-activation";
import { formatPluginSkillName } from "@/skills/plugin-skill-activation";
import { escapeXmlAttr } from "@/skills/skill-activation";
import { listAccessibleCatalogSkills } from "@/skills/skill-catalog-prompt";
import type {
  Agent,
  AgentActivationSkill,
  AgentActivationSkillsResponse,
  ExternalMcpSkillListItem,
  PluginSkillListItem,
  Skill,
} from "@/types";

interface SkillAvailabilityContext {
  organizationId: string;
  userId?: string;
  agentId?: string;
  /** Explicit environment preview for an agent that has not been created. */
  environmentId?: string | null;
}

export type AvailableAgentSkill =
  | { source: "native"; activationName: string; skill: Skill }
  | ProjectedPluginSkill
  | ProjectedExternalSkill;

/**
 * The structured counterpart to `list_skills`: all skill sources visible to
 * the current principal in an agent's environment, with the same projected
 * activation names the MCP tool accepts.
 */
export async function listAvailableAgentSkills(
  params: SkillAvailabilityContext,
): Promise<AvailableAgentSkill[]> {
  const environmentId =
    params.environmentId !== undefined
      ? params.environmentId
      : params.agentId !== undefined
        ? await AgentModel.findEnvironmentId(params.agentId)
        : null;
  const [nativeSkills, externalSkills, pluginSkills] = await Promise.all([
    listAccessibleCatalogSkills({
      organizationId: params.organizationId,
      userId: params.userId,
      environmentId,
    }),
    config.mcpGateway.skillsEnabled
      ? listExternalMcpSkills({
          organizationId: params.organizationId,
          userId: params.userId,
          isMcpServerAdmin: await isMcpServerAdmin(params),
          environmentId,
        })
      : [],
    config.plugins.enabled
      ? listPluginSkills({
          organizationId: params.organizationId,
          userId: params.userId,
        })
      : [],
  ]);
  const effectiveNativeSkills = selectEffectiveNativeSkills(
    nativeSkills,
    params.userId,
  );
  const projectedSkills = projectLiveSkillNames({
    nativeNames: effectiveNativeSkills.map((skill) => skill.name),
    pluginSkills,
    externalSkills,
  });

  return [
    ...effectiveNativeSkills.map((skill) => ({
      source: "native" as const,
      activationName: skill.name,
      skill,
    })),
    ...projectedSkills,
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

function toAgentActivationSkill(
  available: AvailableAgentSkill,
): AgentActivationSkill {
  if (available.source === "native") {
    return {
      reference: { source: "native", skillId: available.skill.id },
      name: available.skill.name,
      activationName: available.activationName,
      description: available.skill.description,
      scope: available.skill.scope,
      providerName: null,
    };
  }
  if (available.source === "plugin") {
    return {
      reference: {
        source: "plugin",
        pluginId: available.skill.pluginId,
        skillPath: available.skill.skillPath,
      },
      name: available.skill.name,
      activationName: available.wireName,
      description: available.skill.description,
      scope: available.skill.scope,
      providerName: available.skill.pluginName,
    };
  }
  return {
    reference: {
      source: "external_mcp",
      mcpServerId: available.skill.mcpServerId,
      uri: available.skill.uri,
    },
    name: available.skill.name,
    activationName: available.wireName,
    description: available.skill.description,
    scope: available.skill.scope,
    providerName: available.skill.serverName,
  };
}

export type ProjectedPluginSkill = {
  source: "plugin";
  wireName: string;
  activationName: string;
  skill: PluginSkillListItem;
};

export type ProjectedExternalSkill = {
  source: "external";
  wireName: string;
  activationName: string;
  skill: ExternalMcpSkillListItem;
};

type ProjectedLiveSkill = ProjectedPluginSkill | ProjectedExternalSkill;

// === Internal helpers ===

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

async function isMcpServerAdmin(
  params: Pick<SkillAvailabilityContext, "organizationId" | "userId">,
): Promise<boolean> {
  if (!params.userId) return false;
  return (
    await getMcpCatalogPermissionChecker({
      userId: params.userId,
      organizationId: params.organizationId,
    })
  ).isAdmin;
}

function projectLiveSkillNames(params: {
  nativeNames: string[];
  pluginSkills: PluginSkillListItem[];
  externalSkills: ExternalMcpSkillListItem[];
}): ProjectedLiveSkill[] {
  const liveSkills: ProjectedLiveSkill[] = [
    ...params.pluginSkills.map((skill) => ({
      source: "plugin" as const,
      wireName: skill.name,
      activationName: skill.name,
      skill,
    })),
    ...params.externalSkills.map((skill) => ({
      source: "external" as const,
      wireName: skill.name,
      activationName: skill.name,
      skill,
    })),
  ];
  const legacyNames = new Set([
    ...params.pluginSkills.map(formatPluginSkillName),
    ...params.externalSkills.map(formatExternalSkillName),
  ]);
  const reservedWireNames = new Set([
    ...params.nativeNames.map(escapeXmlAttr),
    ...liveSkills.map((projected) => escapeXmlAttr(projected.skill.name)),
    ...legacyNames,
  ]);
  const nameCounts = new Map<string, number>();
  for (const name of params.nativeNames) nameCounts.set(name, 1);
  for (const projected of liveSkills) {
    nameCounts.set(
      projected.skill.name,
      (nameCounts.get(projected.skill.name) ?? 0) + 1,
    );
  }

  const assignedWireNames = new Set<string>();
  const namesBySkillKey = new Map<
    string,
    { wireName: string; activationName: string }
  >();
  const skillsByStableIdentity = [...liveSkills].sort((left, right) =>
    projectedSkillKey(left).localeCompare(projectedSkillKey(right)),
  );
  for (const projected of skillsByStableIdentity) {
    const declaredName = projected.skill.name;
    const declaredWireName = escapeXmlAttr(declaredName);
    if (
      nameCounts.get(declaredName) === 1 &&
      !legacyNames.has(declaredWireName)
    ) {
      assignedWireNames.add(declaredWireName);
      namesBySkillKey.set(projectedSkillKey(projected), {
        wireName: declaredWireName,
        activationName: declaredName,
      });
      continue;
    }

    const suffix = projected.source === "plugin" ? "plugin" : "mcp";
    const baseName = `${declaredName}-from-${suffix}`;
    let name = baseName;
    let index = 2;
    while (
      reservedWireNames.has(escapeXmlAttr(name)) ||
      assignedWireNames.has(escapeXmlAttr(name))
    ) {
      name = `${baseName}-${index}`;
      index += 1;
    }
    const wireName = escapeXmlAttr(name);
    assignedWireNames.add(wireName);
    namesBySkillKey.set(projectedSkillKey(projected), {
      wireName,
      activationName: name,
    });
  }

  return liveSkills.map((projected) => {
    const names = namesBySkillKey.get(projectedSkillKey(projected));
    if (names === undefined) throw new Error("Projected skill name is missing");
    return { ...projected, ...names };
  });
}

function projectedSkillKey(skill: ProjectedLiveSkill): string {
  return skill.source === "plugin"
    ? `plugin:${skill.skill.pluginId}:${skill.skill.skillPath}`
    : `external:${skill.skill.mcpServerId}:${skill.skill.id}`;
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
