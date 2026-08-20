import type { SkillDetail } from "./github-sync-panel";

export const SKILL_DESCRIPTION_FALLBACK =
  "A skill is a SKILL.md instruction set plus optional resource files.";

export function skillDetailHref(id: string) {
  return `/skills/${encodeURIComponent(id)}`;
}

export type SkillEditStepId = "content" | "access";

export function skillEditHref(id: string, step?: SkillEditStepId) {
  const base = `${skillDetailHref(id)}/edit`;
  return step ? `${base}?step=${step}` : base;
}

/**
 * The wizard's steps on an existing skill: the create wizard's, less its
 * Source step (the skill's source is settled). Content comes first, as there.
 */
export const SKILL_EDIT_STEPS: ReadonlyArray<{
  id: SkillEditStepId;
  title: string;
}> = [
  { id: "content", title: "Content" },
  { id: "access", title: "Access" },
];

/** The `?step=` the URL names, or the first step for anything else. */
export function resolveSkillEditStep(value: string | null): SkillEditStepId {
  return SKILL_EDIT_STEPS.some((step) => step.id === value)
    ? (value as SkillEditStepId)
    : "content";
}

/** `owner/repo` of a GitHub skill; `sourceRef` is `owner/repo@ref`. */
export function skillGithubSourceRepo(skill: SkillDetail): string | null {
  return skill.sourceType === "github"
    ? (skill.sourceRef?.split("@")[0] ?? null)
    : null;
}
