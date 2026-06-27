import {
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import { SkillModel, SkillTeamModel } from "@/models";
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

  const skills = await SkillModel.findByOrganization({
    organizationId,
    accessibleSkillIds,
  });
  if (skills.length === 0) {
    return null;
  }

  const catalog = skills
    .map(
      (skill) =>
        `<skill name="${escapeXmlAttr(skill.name)}">${neutralizeFrameTags(
          skill.description,
        )}</skill>`,
    )
    .join("\n");

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

  return `<available_skills>\n${catalog}\n</available_skills>\n${instructions}`;
}
