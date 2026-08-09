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
