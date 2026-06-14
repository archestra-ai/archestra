import type { ChatSkillMetadata } from "@archestra/shared";

/** A slash command bound to a skill, e.g. typing `/deep-research` in chat. */
export type SkillCommand = {
  value: string;
  name: string;
  description: string;
  skill: ChatSkillMetadata;
};

/** The built-in admin-only command that toggles hook debug mode. */
export const DEBUG_COMMAND_VALUE = "/debug";

/** True when `text` is exactly the `/debug` command (trimmed, case-insensitive). */
export function isDebugCommand(text: string): boolean {
  return text.trim().toLowerCase() === DEBUG_COMMAND_VALUE;
}

/** Turn a skill name into a slash-command token, e.g. "Deep Research" → "/deep-research". */
export function skillCommandValue(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/${slug || "skill"}`;
}

/**
 * Build one slash command per skill, guaranteeing every token is unique.
 *
 * Skill names are unique within an org, but their slugs are not — "PDF Tools"
 * and "pdf-tools" both slugify to `/pdf-tools`. A colliding token gets a
 * numeric suffix (`/pdf-tools-2`) so each command resolves to exactly one
 * skill; otherwise picking the second skill would silently activate the first.
 */
export function buildSkillCommands(
  skills: { id: string; name: string; description: string }[],
): SkillCommand[] {
  const used = new Set<string>();
  return skills.map(({ id, name, description }) => {
    const base = skillCommandValue(name);
    let value = base;
    for (let suffix = 2; used.has(value); suffix += 1) {
      value = `${base}-${suffix}`;
    }
    used.add(value);
    return { value, name, description, skill: { id, name } };
  });
}

/**
 * If `text` begins with a known skill command token, return the matched skill
 * and the prompt text that follows it. The token is the run of non-whitespace
 * characters up to the first space.
 */
export function parseSkillCommand(
  text: string,
  skillCommands: SkillCommand[],
): { skill: ChatSkillMetadata; value: string; remaining: string } | null {
  if (!text.startsWith("/")) {
    return null;
  }
  const spaceIndex = text.search(/\s/);
  const token = (
    spaceIndex === -1 ? text : text.slice(0, spaceIndex)
  ).toLowerCase();
  const command = skillCommands.find((c) => c.value === token);
  if (!command) {
    return null;
  }
  return {
    skill: command.skill,
    value: command.value,
    remaining: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trimStart(),
  };
}
