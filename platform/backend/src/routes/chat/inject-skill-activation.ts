import {
  type ChatMessage,
  ChatMessageMetadataSchema,
  type ChatMessagePart,
} from "@shared";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import logger from "@/logging";
import { SkillFileModel, SkillModel, SkillTeamModel } from "@/models";
import { formatSkillActivation } from "@/skills/skill-activation";

/**
 * When the last user message was sent via a skill slash command, prepend the
 * skill's activation block to its text so the model receives the skill's
 * instructions directly — no reliance on the model calling `activate_skill`.
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
}: {
  messages: ChatMessage[];
  organizationId: string;
  userId: string;
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

  const files = await SkillFileModel.findBySkillId(skill.id);
  logger.info(
    { organizationId, skillName: skill.name, fileCount: files.length },
    "[Skills] Skill activated via slash command",
  );

  const next = [...messages];
  next[lastUserIndex] = prependText(
    userMessage,
    formatSkillActivation({ skill, files }),
  );
  return next;
}

// ===== Internal helpers =====

/** Prepend `block` to the message's first text part (adding one if absent). */
function prependText(message: ChatMessage, block: string): ChatMessage {
  const parts: ChatMessagePart[] = message.parts ? [...message.parts] : [];
  const textIndex = parts.findIndex((part) => part.type === "text");

  if (textIndex === -1) {
    return { ...message, parts: [{ type: "text", text: block }, ...parts] };
  }

  const textPart = parts[textIndex];
  const existing = typeof textPart.text === "string" ? textPart.text : "";
  parts[textIndex] = {
    ...textPart,
    text: existing ? `${block}\n\n${existing}` : block,
  };
  return { ...message, parts };
}
