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

/** What the chat page should do with a skill resolved from a `?skillId=` deep link. */
export type UrlSkillAction =
  | { kind: "prefill"; text: string }
  | { kind: "none"; reason: "not_found" | "error" | "unavailable" };

/**
 * Decide how a `?skillId=` deep link reaches the composer: prefill it with the
 * skill's slash command (the visible text is the single source of truth —
 * deleting it detaches the skill).
 *
 * The prefill token is looked up in `skillCommands` — the same
 * collision-disambiguated table submit parsing uses — never re-derived from
 * the name: "PDF Tools" and "pdf-tools" both slugify to `/pdf-tools`, so a
 * re-derived token could activate the wrong skill. A skill absent from the
 * table (skill tools disabled for the org, or beyond the command list's page
 * size) is "unavailable" — submit parsing could not resolve its token either.
 */
export function resolveUrlSkillAction(params: {
  skill: { id: string; name: string } | null;
  isError: boolean;
  skillCommands: SkillCommand[];
}): UrlSkillAction {
  const { skill, isError, skillCommands } = params;
  if (isError) {
    return { kind: "none", reason: "error" };
  }
  if (!skill) {
    return { kind: "none", reason: "not_found" };
  }
  const command = skillCommands.find((c) => c.skill.id === skill.id);
  if (!command) {
    return { kind: "none", reason: "unavailable" };
  }
  return { kind: "prefill", text: `${command.value} ` };
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
