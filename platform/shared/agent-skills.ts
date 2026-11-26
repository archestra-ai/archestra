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
 * Why a NEW skill name cannot be used, as a sentence for the person typing
 * it, or null when it can.
 *
 * This is the storage rule, far looser than `isSpecCompliantSkillName`: spaces,
 * capitals and emoji are fine, and a name that breaks the Agent Skills rules
 * is only withheld from publication. What is refused is a name that cannot be
 * one folder name, because a skill's files are mounted at `/skills/<name>`
 * (`skillRootPath`) and a name with a slash, a `..` or a line break never
 * mounts.
 *
 * Asked only when a name is first given or changed. A stored skill that breaks
 * it (older rows, Git imports) keeps loading and saving under its name.
 */
export function describeUnusableSkillName(name: string): string | null {
  if (name.trim() === "") return "Give the skill a name.";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being refused
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return "A skill name must be a single line of text.";
  }
  if (name.includes("/") || name.includes("\\")) {
    return "A skill name cannot contain a slash. Use a hyphen instead.";
  }
  if (name === "." || name.includes("..")) {
    return "A skill name cannot be a dot or contain two dots in a row.";
  }
  if (new TextEncoder().encode(name).length > MAX_SKILL_NAME_BYTES) {
    return `A skill name can be at most ${MAX_SKILL_NAME_BYTES} bytes long. Shorten it.`;
  }
  return null;
}

/** The longest folder name the common filesystems hold. */
const MAX_SKILL_NAME_BYTES = 255;
