import {
  type ChatMessage,
  ChatMessageMetadataSchema,
  type ChatMessagePart,
} from "@shared";
import logger from "@/logging";
import { SkillFileModel, SkillModel } from "@/models";
import { formatSkillActivation } from "@/skills/skill-activation";

/**
 * When the last user message was sent via a skill slash command, prepend the
 * skill's activation block to its text so the model receives the skill's
 * instructions directly — no reliance on the model calling `activate_skill`.
 *
 * Returns a shallow copy with the block applied; the original `messages` (used
 * for persistence and the visible bubble) are left untouched. If the org flag
 * is off, the metadata is absent, or the skill cannot be resolved, the input is
 * returned unchanged.
 */
export async function injectSkillActivation({
  messages,
  organizationId,
}: {
  messages: ChatMessage[];
  organizationId: string;
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
