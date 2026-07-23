import {
  type ChatMessage,
  ChatMessageMetadataSchema,
  SKILL_TOOL_PREFIX,
  slugify,
} from "@archestra/shared";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import logger from "@/logging";
import {
  AgentModel,
  SkillEnvironmentModel,
  SkillModel,
  SkillTeamModel,
  SkillVersionModel,
} from "@/models";
import { skillVisibleInEnvironment } from "@/services/environments/environment-isolation";
import {
  buildSkillActivationPromptContext,
  escapeXmlAttr,
  formatSkillActivation,
  neutralizeFrameTags,
} from "@/skills/skill-activation";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import { resolveActivationVersion } from "@/skills/skill-version-resolution";
import { spliceText } from "./augment-last-user-message";

/**
 * When the last user message was sent via a skill slash command, prepend the
 * skill's activation block to its text so the model receives the skill's
 * instructions directly — no reliance on the model calling `load_skill`.
 * An agent-designated skill (SKILL.md `agent`) gets a delegation directive
 * instead: the model is told to run it via its `skill__<slug>` tool.
 *
 * Returns a shallow copy with the block applied; the original `messages` (used
 * for persistence and the visible bubble) are left untouched. If the org flag
 * is off, the metadata is absent, the user lacks `skill:read`, or the skill
 * cannot be resolved or accessed by the user (per its scope), the input is
 * returned unchanged.
 */
export async function injectSkillActivation({
  messages,
  organizationId,
  userId,
  agentId,
  conversationId,
}: {
  messages: ChatMessage[];
  organizationId: string;
  userId: string;
  /** The conversation's agent — gates the sandbox hint on tool assignment. */
  agentId: string | undefined;
  /** Conversation the skill is activated in — pins/reads the mounted version. */
  conversationId: string | undefined;
}): Promise<ChatMessage[]> {
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  if (lastUserIndex === -1) {
    return messages;
  }

  const userMessage = messages[lastUserIndex];
  const skillRef = ChatMessageMetadataSchema.safeParse(userMessage.metadata)
    .data?.skill;
  if (!skillRef) {
    return messages;
  }

  const skill = await SkillModel.findById(skillRef.id);
  if (!skill || skill.organizationId !== organizationId) {
    logger.warn(
      { organizationId, skillId: skillRef.id },
      "[Skills] Slash-command skill not found for org; sending message unchanged",
    );
    return messages;
  }

  // Enforce RBAC — a slash command must not bypass the `skill:read` gate that
  // guards the skills API and the MCP skill tools.
  const checker = await getSkillPermissionChecker({ userId, organizationId });
  if (!checker.canRead) {
    logger.warn(
      { organizationId, userId, skillId: skill.id },
      "[Skills] User lacks skill:read for slash-command skill; sending message unchanged",
    );
    return messages;
  }

  // Enforce the skill's scope on top of the read gate.
  const hasAccess = await SkillTeamModel.userHasSkillAccess({
    organizationId,
    userId,
    skill,
    isSkillAdmin: checker.isAdmin,
  });
  if (!hasAccess) {
    logger.warn(
      { organizationId, userId, skillId: skill.id },
      "[Skills] User lacks access to slash-command skill; sending message unchanged",
    );
    return messages;
  }

  // Skills are environment-scoped like tools and connectors: a slash command
  // must not activate a skill from another environment (skills with no
  // environment assignments and built-in skills are visible everywhere).
  if (agentId !== undefined) {
    const [environmentId, environmentIdsBySkill] = await Promise.all([
      AgentModel.findEnvironmentId(agentId),
      SkillEnvironmentModel.getEnvironmentIdsForSkills([skill.id]),
    ]);
    const skillEnvironments = {
      sourceType: skill.sourceType,
      environmentIds: environmentIdsBySkill.get(skill.id) ?? [],
    };
    if (!skillVisibleInEnvironment(skillEnvironments, environmentId)) {
      logger.warn(
        { organizationId, agentId, skillId: skill.id },
        "[Skills] Slash-command skill is outside the agent's environment; sending message unchanged",
      );
      return messages;
    }
  }

  // An agent-designated skill runs in its subagent, not inline: instead of the
  // instructions, prepend a directive to call the skill's `skill__<slug>`
  // delegation tool (advertised whenever the designated agent resolves for
  // this caller). The dispatch path renders the instructions for the subagent.
  if (skill.agentName !== null) {
    const toolName = `${SKILL_TOOL_PREFIX}${slugify(skill.name)}`;
    logger.info(
      { organizationId, skillName: skill.name, agentName: skill.agentName },
      "[Skills] Agent-designated skill activated via slash command; injecting delegation directive",
    );
    const next = [...messages];
    next[lastUserIndex] = spliceText(
      userMessage,
      `<skill_delegation skill="${escapeXmlAttr(skill.name)}" agent="${escapeXmlAttr(skill.agentName)}">\n` +
        `This skill runs in the "${neutralizeFrameTags(skill.agentName)}" subagent. Call the \`${toolName}\` ` +
        "tool now, passing the user's request below as `message` — the " +
        "subagent receives the skill's instructions automatically and " +
        "returns the result. Do not attempt the skill's task yourself. If " +
        `\`${toolName}\` is not in your tools list, tell the user the ` +
        "skill's designated agent is not available to them.\n" +
        "</skill_delegation>",
      "prepend",
    );
    return next;
  }

  const canRunSandbox = await isSkillSandboxAvailableForAgent({
    userId,
    organizationId,
    agentId,
  });

  // resolve the effective version and pin it by mounting (shared with
  // load_skill), so the injected block, the mounted bytes, and a later
  // load_skill file read all expose the same version.
  const activation = await resolveActivationVersion({
    skill,
    organizationId,
    userId,
    conversationId,
    canRunSandbox,
  });
  if (!activation) {
    return messages;
  }
  const { version, mounted } = activation;
  const files = await SkillVersionModel.findFiles(version.id);

  // an inline slash-command activation counts one use; the agent-designated
  // branch above doesn't — its use is counted at delegation dispatch.
  SkillModel.recordUsage({ skillId: skill.id, userId });
  logger.info(
    {
      organizationId,
      skillName: skill.name,
      version: version.version,
      mounted,
      fileCount: files.length,
    },
    "[Skills] Skill activated via slash command",
  );

  const next = [...messages];
  next[lastUserIndex] = spliceText(
    userMessage,
    formatSkillActivation({
      skill: {
        name: skill.name,
        content: version.content,
        compatibility: skill.compatibility,
        allowedTools: skill.allowedTools,
        templated: skill.templated,
      },
      version: version.version,
      files,
      // only claim sandbox runnability when this skill actually holds the mount.
      canRunSandbox: mounted,
      promptContext: skill.templated
        ? await buildSkillActivationPromptContext({ userId, organizationId })
        : null,
    }),
    "prepend",
  );
  return next;
}
