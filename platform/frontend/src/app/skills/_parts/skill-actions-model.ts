import type { Permissions } from "@archestra/shared";
import { ACTION_LABEL } from "@/lib/design/resource-lexicon";
import { skillEditHref, skillUsageHref } from "./skill-page-config";

export type SkillActionId = "chat" | "edit" | "usage" | "history" | "delete";

export interface SkillActionDefinition {
  id: SkillActionId;
  label: string;
  permissions: Permissions;
  href?: string;
}

/** Canonical active-skill actions for table rows and detail headers. */
export function getSkillActionModel(skillId: string): SkillActionDefinition[] {
  return [
    {
      id: "chat",
      label: ACTION_LABEL.chat,
      permissions: { chat: ["read", "create"] },
      href: `/chat/new?skill_id=${skillId}`,
    },
    {
      id: "edit",
      label: ACTION_LABEL.edit,
      permissions: { skill: ["update"] },
      href: skillEditHref(skillId),
    },
    {
      id: "usage",
      label: "Usage",
      permissions: { skill: ["read"] },
      href: skillUsageHref(skillId),
    },
    {
      id: "history",
      label: ACTION_LABEL.versionHistory,
      permissions: { skill: ["read"] },
    },
    {
      id: "delete",
      label: ACTION_LABEL.delete,
      permissions: { skill: ["delete"] },
    },
  ];
}

export function skillAction(model: SkillActionDefinition[], id: SkillActionId) {
  const definition = model.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Missing skill action definition: ${id}`);
  return definition;
}

export function skillActionHref(definition: SkillActionDefinition): string {
  if (!definition.href) {
    throw new Error(`Skill action has no destination: ${definition.id}`);
  }
  return definition.href;
}
