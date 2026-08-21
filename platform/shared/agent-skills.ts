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
 * Most skill ids one bulk request may carry. The bulk routes cap the array so
 * a single call cannot fan out unboundedly; the Skills page reads the same
 * number to decide whether it can offer "select every matching skill" at all.
 */
export const MAX_BULK_SKILL_IDS = 500;
