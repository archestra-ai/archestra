import { type ChatMessage, ChatMessageMetadataSchema } from "@archestra/shared";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import logger from "@/logging";
import { SkillModel, SkillTeamModel, SkillVersionModel } from "@/models";
import {
  buildSkillActivationPromptContext,
  formatSkillActivation,
} from "@/skills/skill-activation";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import { resolveActivationVersion } from "@/skills/skill-version-resolution";
import { spliceText } from "./augment-last-user-message";

/**
 * When the last user message was sent via a skill slash command, prepend the
 * skill's activation block to its text so the model receives the skill's
 * instructions directly — no reliance on the model calling `load_skill`.
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
