import {
  SKILL_TOOL_PREFIX,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import { AgentModel, SkillModel, SkillTeamModel } from "@/models";
import { escapeXmlAttr, neutralizeFrameTags } from "./skill-activation";
import { isSkillSandboxAvailableForAgent } from "./skill-sandbox-availability";

/**
 * Build the `<available_skills>` catalog block — one line per accessible skill
 * (name + description) followed by a short activation instruction. Shared by the
 * `list_skills` tool and the eager system-prompt injection so both stay in sync.
 *
 * Returns null when the caller has no accessible skills, leaving the empty-state
 * handling to the caller (a tool message for `list_skills`, or omitting the
 * block from a system prompt).
 */
export async function buildSkillCatalogPrompt(params: {
  organizationId: string;
  userId?: string;
  agentId?: string;
}): Promise<string | null> {
  const { organizationId, userId, agentId } = params;

  const checker =
    userId !== undefined
      ? await getSkillPermissionChecker({ userId, organizationId })
      : null;
  const isSkillAdmin = checker?.isAdmin ?? false;
  const accessibleSkillIds = isSkillAdmin
    ? undefined
    : await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId,
        userId,
      });

  // Skills are environment-scoped like tools and connectors: the catalog only
  // shows skills in the agent's environment (null = Default; built-ins exempt).
  // Skill-admin visibility widens the scope filter, never the environment one.
  const environmentId =
    agentId !== undefined
      ? await AgentModel.findEnvironmentId(agentId)
      : undefined;

  const skills = await SkillModel.findByOrganization({
    organizationId,
    accessibleSkillIds,
    environmentId,
  });
  if (skills.length === 0) {
    return null;
  }

  const catalog = skills
    .map((skill) => {
      // an agent-designated skill runs in that subagent via its skill__<slug>
      // tool; the agent attribute steers the model away from load_skill.
      const agentAttr =
        skill.agentName !== null
          ? ` agent="${escapeXmlAttr(skill.agentName)}"`
          : "";
      return `<skill name="${escapeXmlAttr(skill.name)}"${agentAttr}>${neutralizeFrameTags(
        skill.description,
      )}</skill>`;
    })
    .join("\n");

  const hasAgentDesignatedSkills = skills.some(
    (skill) => skill.agentName !== null,
  );
  const agentDesignatedNote = hasAgentDesignatedSkills
    ? ` A skill with an agent attribute runs in that subagent — call its ${SKILL_TOOL_PREFIX}<name> tool with your task as \`message\` instead of loading it.`
    : "";

  // only advertise the sandbox path when it would actually work: the feature is
  // enabled, the caller has sandbox:execute, and the sandbox tools are assigned
  // to this agent (so they appear in its tools/list).
  const loadSkill = archestraMcpBranding.getToolName(
    TOOL_LOAD_SKILL_SHORT_NAME,
  );
  const runCommand = archestraMcpBranding.getToolName(
    TOOL_RUN_COMMAND_SHORT_NAME,
  );
  const instructions = (await isSkillSandboxAvailableForAgent({
    userId,
    organizationId,
    agentId,
  }))
    ? `Call ${loadSkill} with one of these names to load its instructions. ` +
      "Loading a skill mounts it in your sandbox under /skills, so you can " +
      `then run its scripts or shell commands with ${runCommand}. A skill ` +
      "appears under /skills/<name> only after you load it — an empty " +
      "/skills listing does not mean the skill is unavailable."
    : `Call ${loadSkill} with one of these names to load its instructions.`;

  return `<available_skills>\n${catalog}\n</available_skills>\n${instructions}${agentDesignatedNote}`;
}
