import type { SkillDetail } from "./github-sync-panel";

export const SKILL_DESCRIPTION_FALLBACK =
  "A skill is a SKILL.md instruction set plus optional resource files.";

/**
 * The sections of a skill's own page. Settings is the whole skill on one
 * page — the same form the create wizard fills — and is the page's default,
 * so it carries no `?section=`. Usage is the view onto a skill already in use.
 */
export type SkillDetailSection = "settings" | "usage";

export const SKILL_DETAIL_SECTIONS: readonly SkillDetailSection[] = [
  "settings",
  "usage",
];

export const SKILL_SECTION_LABELS: Record<SkillDetailSection, string> = {
  settings: "Settings",
  usage: "Usage",
};

export function skillDetailHref(id: string, section?: SkillDetailSection) {
  const base = `/skills/${encodeURIComponent(id)}`;
  return section && section !== DEFAULT_SKILL_SECTION
    ? `${base}?section=${section}`
    : base;
}

/**
 * The skill page's Usage section. Usage used to be a dialog opened from the
 * list and from the detail header; it is a section now, so both open the same
 * URL and a link to one person's reading of it survives being pasted to
 * someone else.
 */
export function skillUsageHref(id: string) {
  return skillDetailHref(id, "usage");
}

/**
 * Where "edit this skill" lands. Editing is not a page of its own any more —
 * the skill's page *is* its settings — so every edit link in the app resolves
 * there.
 */
export function skillEditHref(id: string) {
  return skillDetailHref(id, "settings");
}

/** The section a `?section=` (or a legacy `?tab=`) names, or the first. */
export function resolveSkillDetailSection(
  value: string | null | undefined,
): SkillDetailSection {
  return (
    SKILL_DETAIL_SECTIONS.find((section) => section === value) ??
    DEFAULT_SKILL_SECTION
  );
}

/** `owner/repo` of a GitHub skill; `sourceRef` is `owner/repo@ref`. */
export function skillGithubSourceRepo(skill: SkillDetail): string | null {
  return skill.sourceType === "github"
    ? (skill.sourceRef?.split("@")[0] ?? null)
    : null;
}

const DEFAULT_SKILL_SECTION: SkillDetailSection = "settings";
