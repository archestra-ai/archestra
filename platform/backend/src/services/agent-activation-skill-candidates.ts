import { getMcpCatalogPermissionChecker } from "@/auth/mcp-catalog-permissions";
import config from "@/config";
import { AgentModel } from "@/models";
import { listPluginSkills } from "@/plugins/plugin-skills";
import { listExternalMcpSkills } from "@/services/external-mcp-skills";
import { listAccessibleCatalogSkills } from "@/skills/skill-catalog-prompt";
import type {
  AgentActivationSkillReference,
  ExternalMcpSkillListItem,
  PluginSkillListItem,
  Skill,
} from "@/types";

export interface SkillAvailabilityContext {
  organizationId: string;
  userId?: string;
  agentId?: string;
  /** Draft or pending-edit environment override; takes precedence over agentId. */
  environmentId?: string | null;
}

export type PolicyIndependentAvailableAgentSkill =
  | { source: "native"; skill: Skill }
  | { source: "plugin"; skill: PluginSkillListItem }
  | { source: "external"; skill: ExternalMcpSkillListItem };

export function getAvailableAgentSkillReference(
  available: PolicyIndependentAvailableAgentSkill,
): AgentActivationSkillReference {
  if (available.source === "native") {
    return { source: "native", skillId: available.skill.id };
  }
  if (available.source === "plugin") {
    return {
      source: "plugin",
      pluginId: available.skill.pluginId,
      skillPath: available.skill.skillPath,
    };
  }
  return {
    source: "external_mcp",
    mcpServerId: available.skill.mcpServerId,
    uri: available.skill.uri,
  };
}

/**
 * Caller/source/environment-visible candidates before an agent policy,
 * native-name precedence, or cross-source name projection. Policy editing
 * uses this seam so a restrictive policy cannot hide the choices needed to
 * change it.
 */
export async function listPolicyIndependentAvailableAgentSkills(
  params: SkillAvailabilityContext,
): Promise<PolicyIndependentAvailableAgentSkill[]> {
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
  return [
    ...nativeSkills.map((skill) => ({ source: "native" as const, skill })),
    ...pluginSkills.map((skill) => ({ source: "plugin" as const, skill })),
    ...externalSkills.map((skill) => ({ source: "external" as const, skill })),
  ];
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
