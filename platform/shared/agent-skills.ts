/**
 * Agent Skills (agentskills.io) naming rules for the `name` frontmatter
 * field: 1-64 characters, lowercase ASCII letters and digits with single
 * hyphens between runs — no leading, trailing, or consecutive hyphens.
 * https://agentskills.io/specification#name-field
 *
 * Archestra accepts any name a user types; conformance matters only where a
 * skill is published to SEP-2640 hosts, whose URI contract requires the final
 * path segment to equal the frontmatter name and which may refuse entries
 * that break the naming rules.
 */
export function isSpecCompliantSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/**
 * Agent Skills length limits for the other frontmatter fields a published
 * skill must carry: `description` is required at 1-1024 characters,
 * `compatibility` optional at 1-500.
 * https://agentskills.io/specification
 *
 * Counted in code points, not UTF-16 units, because the SQL twins of these
 * gates use `char_length`, which counts code points — a surrogate-pair emoji
 * must weigh the same on both sides or the expressions drift.
 */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_COMPATIBILITY_LENGTH = 500;

export function isSpecCompliantSkillDescription(description: string): boolean {
  const codePoints = [...description].length;
  return codePoints >= 1 && codePoints <= MAX_SKILL_DESCRIPTION_LENGTH;
}

/**
 * Absent and empty gate identically: the manifest serializer omits a falsy
 * `compatibility`, so an empty stored value publishes as no field at all and
 * only the upper bound can make a manifest non-conformant.
 */
export function isSpecCompliantSkillCompatibility(
  compatibility: string | null,
): boolean {
  return [...(compatibility ?? "")].length <= MAX_SKILL_COMPATIBILITY_LENGTH;
}

/**
 * `internal_code` of a save refused because SKILL.md cannot be read as a
 * skill. Its `details` say where, so an editor can mark the line.
 */
export const SKILL_MANIFEST_INVALID_CODE = "skill_manifest_invalid";

export interface SkillManifestInvalidDetails {
  /**
   * The line of SKILL.md to fix, counted from 1. Line 1, the opening `---`,
   * when the problem is something the frontmatter lacks.
   */
  line: number;
}

/**
 * Why a NEW skill name cannot be used, as a sentence for the person typing
 * it, or null when it can.
 *
 * A new name has to follow the Agent Skills naming rules
 * (`isSpecCompliantSkillName`). One rule for every way a person names a
 * skill, so no skill is created that works in one place and is left out of
 * another: a gateway publishes only names that follow the rules. Such a name
 * is also always one folder name, which the mount at `/skills/<name>`
 * (`skillRootPath`) needs.
 *
 * Asked only when a name is first given or changed. A stored skill that breaks
 * it (older rows, Git imports, built-ins) keeps loading and saving under its
 * name.
 */
export function describeUnusableSkillName(name: string): string | null {
  if (name.trim() === "") return "Give the skill a name.";
  if (!isSpecCompliantSkillName(name)) {
    return `${INVALID_SKILL_NAME_LEAD}${SKILL_NAME_RULE}.`;
  }
  return null;
}

/**
 * The refusal in two parts, so a form can make the rule a link to
 * `SKILL_NAME_SPEC_URL` while the API sends the same words as plain text.
 */
export const INVALID_SKILL_NAME_LEAD =
  "This name can't be used. Skill name can only contain ";
export const SKILL_NAME_RULE =
  "lowercase letters, digits and single hyphens, up to 64 characters";

/** Where the Agent Skills specification states the naming rules. */
export const SKILL_NAME_SPEC_URL =
  "https://agentskills.io/specification#name-field";

/**
 * Why a NEW skill description cannot be used, as a sentence for the person
 * typing it, or null when it can: the Agent Skills specification takes 1 to
 * `MAX_SKILL_DESCRIPTION_LENGTH` characters.
 *
 * Asked only when a description is first given or changed, like the name
 * rule above: a stored skill with a longer one keeps saving its other fields.
 */
export function describeUnusableSkillDescription(
  description: string,
): string | null {
  if (description.trim() === "") return "Give the skill a description.";
  if (!isSpecCompliantSkillDescription(description)) {
    return `${INVALID_SKILL_DESCRIPTION_LEAD}${SKILL_DESCRIPTION_RULE}.`;
  }
  return null;
}

/** The refusal in two parts, like the name's, so a form can link the rule. */
export const INVALID_SKILL_DESCRIPTION_LEAD =
  "This description is too long. Skill description can be ";
export const SKILL_DESCRIPTION_RULE = `up to ${MAX_SKILL_DESCRIPTION_LENGTH} characters`;

/** Where the Agent Skills specification states the description's limits. */
export const SKILL_DESCRIPTION_SPEC_URL =
  "https://agentskills.io/specification#description-field";
