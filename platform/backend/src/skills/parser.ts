import { load as parseYaml, YAMLException } from "js-yaml";
import type { SkillFileKind } from "@/types";

/**
 * Parses `SKILL.md` files into structured skill metadata, and classifies
 * bundled resource files. See <https://agentskills.io/specification>.
 */

/** Frontmatter fields plus the markdown body of a `SKILL.md` file. */
export interface ParsedSkill {
  name: string;
  description: string;
  /** The markdown body, frontmatter stripped. */
  content: string;
  license: string | null;
  compatibility: string | null;
  /**
   * Space-separated `allowed-tools` list, normalized from either a string or a
   * YAML sequence. `null` when the field is absent or empty.
   */
  allowedTools: string | null;
  /**
   * Optional `agent` field: the name of the agent the skill runs in. When set,
   * activation delegates the skill to that agent instead of loading the
   * instructions into the caller's context.
   */
  agentName: string | null;
  /** When true, the body is rendered through Handlebars at activation. */
  templated: boolean;
  metadata: Record<string, string>;
}

/** Raised when a `SKILL.md` file cannot be parsed into a valid skill. */
export class SkillParseError extends Error {
  /**
   * The line of the file to fix, counted from 1, for an editor to mark.
   * Line 1 (the opening `---`) when the problem is something the frontmatter
   * lacks, which no line of its own holds.
   */
  readonly line: number;

  constructor(message: string, line = 1) {
    super(message);
    this.name = "SkillParseError";
    this.line = line;
  }
}

/** The canonical name of the instructions file in a skill directory. */
export const SKILL_MANIFEST_FILENAME = "SKILL.md";

/**
 * Parse a raw `SKILL.md` file into frontmatter metadata and a markdown body.
 *
 * @throws {SkillParseError} when frontmatter is missing, malformed, or lacks
 * the required `name`/`description` fields. Its message is shown as it is to
 * the author (a toast, an import row) and to a model (a tool result), so it is
 * one plain sentence that says what to change.
 */
export function parseSkillManifest(raw: string): ParsedSkill {
  // A SKILL.md authored on Windows can carry a leading UTF-8 BOM, which
  // github-import preserves (it decodes with ignoreBOM). Strip it so the
  // frontmatter block, anchored at the start of the string, still matches.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) {
    throw new SkillParseError(
      "SKILL.md must start with a YAML frontmatter block delimited by ---",
    );
  }

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]);
  } catch (error) {
    throw new SkillParseError(
      describeInvalidFrontmatter(error),
      invalidFrontmatterLine(error) ?? FRONTMATTER_FIRST_LINE,
    );
  }

  if (
    frontmatter === null ||
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter)
  ) {
    throw new SkillParseError(
      "SKILL.md frontmatter must be a list of `key: value` lines, starting with `name` and `description`.",
      FRONTMATTER_FIRST_LINE,
    );
  }

  const fields = frontmatter as Record<string, unknown>;
  const name = readRequiredText(fields, "name", match[1]);
  const description = readRequiredText(fields, "description", match[1]);

  return {
    name,
    description,
    content: text.slice(match[0].length).trim(),
    license: readString(fields.license) || null,
    compatibility: readString(fields.compatibility) || null,
    allowedTools: readAllowedTools(fields["allowed-tools"]),
    agentName: readString(fields.agent) || null,
    templated: readBoolean(fields.templated),
    metadata: readStringMap(fields.metadata),
  };
}

/**
 * Normalize an `allowed-tools` list into the stored space-separated string.
 * The spec defines the field as space-separated, but YAML authors often write
 * a sequence and API callers send arrays; accept any mix of space-separated
 * strings. Returns `null` when nothing usable remains.
 */
export function normalizeAllowedTools(tools: string[]): string | null {
  const normalized = tools
    .flatMap((tool) => tool.split(/\s+/))
    .map((tool) => tool.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized.join(" ") : null;
}

/**
 * Classify a resource file by its path prefix. Files that are not clearly
 * scripts or assets default to `reference`.
 */
export function deriveSkillFileKind(path: string): SkillFileKind {
  const normalized = path.replace(/^\.?\//, "").toLowerCase();
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";
  if (normalized.startsWith("references/")) return "reference";
  return /\.(md|mdx|txt|markdown)$/.test(normalized) ? "reference" : "asset";
}

// ===== Internal helpers =====

/**
 * A required frontmatter field as trimmed text, or a `SkillParseError` that
 * says what to change.
 *
 * YAML types a bare value: `name: 123` is a number, `name: true` a boolean,
 * `name: 2026-01-01` a date and a bare `name:` nothing at all. None of those is
 * a missing field to the person who typed one, so each gets its own sentence
 * instead of "missing `name`".
 */
function readRequiredText(
  fields: Record<string, unknown>,
  key: "name" | "description",
  /** The frontmatter block as written, to say which line holds the key. */
  block: string,
): string {
  const value = fields[key];
  const line = frontmatterKeyLine(block, key);
  if (typeof value === "string") {
    if (value.trim()) return value.trim();
    throw new SkillParseError(
      `SKILL.md frontmatter has an empty \`${key}\`. Add text after \`${key}:\`.`,
      line,
    );
  }
  if (!(key in fields)) {
    // No line holds a key that is not there.
    throw new SkillParseError(`SKILL.md frontmatter is missing \`${key}\``);
  }
  if (value === null || value === undefined) {
    throw new SkillParseError(
      `SKILL.md frontmatter has an empty \`${key}\`. Add text after \`${key}:\`.`,
      line,
    );
  }
  throw new SkillParseError(
    `SKILL.md frontmatter \`${key}\` must be text. Wrap the value in quotes, for example \`${key}: "123"\`.`,
    line,
  );
}

/**
 * The file line a top-level frontmatter key is written on, or line 1 when the
 * block has no such line (a key written in flow style, say).
 */
function frontmatterKeyLine(block: string, key: string): number {
  const index = block
    .split(/\r?\n/)
    .findIndex((line) => line.startsWith(`${key}:`));
  return index === -1 ? 1 : index + FRONTMATTER_FIRST_LINE;
}

/** The block starts on line 2 of the file, under the opening `---`. */
const FRONTMATTER_FIRST_LINE = 2;

/**
 * One plain sentence for frontmatter YAML cannot read.
 *
 * js-yaml's own message carries a code frame (several lines, a caret) written
 * for a terminal, and this text is shown to the author in a toast and to a
 * model in a tool result. The line is kept, since it is what the author needs
 * to find the place; the frame and the parser's wording are not. By far the
 * most common cause is an unquoted value holding `: ` (`description: Use
 * when: ...`), so the remedy names it.
 */
function describeInvalidFrontmatter(error: unknown): string {
  const line = invalidFrontmatterLine(error);
  return (
    `SKILL.md frontmatter is not valid YAML${line === null ? "" : ` (line ${line})`}. ` +
    'If a value contains a colon or starts with a special character, wrap it in quotes, for example `description: "Use when: the user asks"`.'
  );
}

/** The file line YAML stopped on, or null when the parser gave none. */
function invalidFrontmatterLine(error: unknown): number | null {
  return error instanceof YAMLException && typeof error.mark?.line === "number"
    ? // `mark.line` counts from 0 inside the block.
      error.mark.line + FRONTMATTER_FIRST_LINE
    : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readAllowedTools(value: unknown): string | null {
  const tools = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? [value]
      : [];
  return normalizeAllowedTools(tools);
}

/** Coerce a YAML scalar into a boolean, accepting `true` or the string "true". */
function readBoolean(value: unknown): boolean {
  return (
    value === true || (typeof value === "string" && value.trim() === "true")
  );
}

/** Coerce a YAML mapping into a flat `Record<string, string>`. */
function readStringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    result[key] =
      typeof raw === "string" || typeof raw === "number"
        ? String(raw)
        : JSON.stringify(raw);
  }
  return result;
}
