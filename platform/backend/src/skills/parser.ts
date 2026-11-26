import { CORE_SCHEMA, load as parseYaml, YAMLException } from "js-yaml";
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
  /**
   * The frontmatter block as written, without its `---` fences. Null for a
   * skill that was not parsed from a manifest (a draft converted from an
   * agent). Stored beside the columns so the keys, nesting and comments the
   * columns do not hold survive an edit; see `skills.frontmatter_source`.
   */
  frontmatterSource: string | null;
}

/** Raised when a `SKILL.md` file cannot be parsed into a valid skill. */
export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillParseError";
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
    throw new SkillParseError(describeInvalidFrontmatter(error));
  }

  if (
    frontmatter === null ||
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter)
  ) {
    throw new SkillParseError(
      "SKILL.md frontmatter must be a list of `key: value` lines, starting with `name` and `description`.",
    );
  }

  const fields = frontmatter as Record<string, unknown>;
  const name = readRequiredText(fields, "name");
  const description = readRequiredText(fields, "description");

  return {
    name,
    description,
    content: text.slice(match[0].length).trim(),
    ...readOptionalFields(fields),
    frontmatterSource: match[1],
  };
}

/**
 * Whether a stored frontmatter block still says what a skill's columns say.
 *
 * The block is kept so an edit gives back what was written, but the columns
 * are what Archestra acts on. A writer can move a column without rewriting
 * the block (an explicit `allowedTools` in a request body wins over the
 * manifest's). From then on the block would show the editor a value the skill
 * no longer has, and the next save would put the old value back. The model
 * asks this on every write and drops a block that has drifted.
 */
export function frontmatterSourceMatches(
  source: string,
  skill: FrontmatterColumns,
): boolean {
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(source);
  } catch {
    return false;
  }
  if (!isPlainMap(frontmatter)) return false;
  const written = readOptionalFields(frontmatter);
  return (
    readString(frontmatter.name) === skill.name &&
    readString(frontmatter.description) === skill.description &&
    written.license === (skill.license ?? null) &&
    written.compatibility === (skill.compatibility ?? null) &&
    written.allowedTools === (skill.allowedTools ?? null) &&
    written.agentName === (skill.agentName ?? null) &&
    written.templated === (skill.templated ?? false) &&
    sameStringMap(written.metadata, skill.metadata ?? {})
  );
}

/**
 * What a stored frontmatter block holds beyond the columns, for a writer that
 * builds a `SKILL.md` from the columns and must not lose the rest (the
 * marketplace copy a client installs).
 *
 * `fields` are the top-level keys no column stores, in the author's order.
 * `metadata` are the `metadata` entries whose value is a map or a list: the
 * `metadata` column keeps those as one line of JSON text, which is what the
 * Agent Skills format asks of a published skill, and this is the structured
 * form the author wrote.
 *
 * Read with YAML's core types only, so a date stays the text that was typed
 * instead of becoming a timestamp. Empty for a block that cannot be read.
 */
export function extraFrontmatter(source: string | null | undefined): {
  fields: Record<string, unknown>;
  metadata: Record<string, unknown>;
} {
  const nothing = { fields: {}, metadata: {} };
  if (!source) return nothing;
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(source, { schema: CORE_SCHEMA });
  } catch {
    return nothing;
  }
  if (!isPlainMap(frontmatter)) return nothing;
  return {
    fields: Object.fromEntries(
      Object.entries(frontmatter).filter(
        ([key, value]) => !STORED_FRONTMATTER_KEYS.has(key) && value != null,
      ),
    ),
    metadata: isPlainMap(frontmatter.metadata)
      ? Object.fromEntries(
          Object.entries(frontmatter.metadata).filter(
            ([, value]) => typeof value === "object" && value !== null,
          ),
        )
      : {},
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

/** The frontmatter keys a skill's columns store. */
const STORED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "allowed-tools",
  "agent",
  "templated",
  "metadata",
]);

/** The skill columns a frontmatter block is compared against. */
interface FrontmatterColumns {
  name: string;
  description: string;
  license?: string | null;
  compatibility?: string | null;
  allowedTools?: string | null;
  agentName?: string | null;
  templated?: boolean | null;
  metadata?: Record<string, string> | null;
}

/** The optional frontmatter fields, read the one way every caller needs. */
function readOptionalFields(fields: Record<string, unknown>) {
  return {
    license: readString(fields.license) || null,
    compatibility: readString(fields.compatibility) || null,
    allowedTools: readAllowedTools(fields["allowed-tools"]),
    agentName: readString(fields.agent) || null,
    templated: readBoolean(fields.templated),
    metadata: readStringMap(fields.metadata),
  };
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringMap(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

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
): string {
  const value = fields[key];
  if (typeof value === "string") {
    if (value.trim()) return value.trim();
    throw new SkillParseError(
      `SKILL.md frontmatter has an empty \`${key}\`. Add text after \`${key}:\`.`,
    );
  }
  if (!(key in fields)) {
    throw new SkillParseError(`SKILL.md frontmatter is missing \`${key}\``);
  }
  if (value === null || value === undefined) {
    throw new SkillParseError(
      `SKILL.md frontmatter has an empty \`${key}\`. Add text after \`${key}:\`.`,
    );
  }
  throw new SkillParseError(
    `SKILL.md frontmatter \`${key}\` must be text. Wrap the value in quotes, for example \`${key}: "123"\`.`,
  );
}

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
  const line =
    error instanceof YAMLException && typeof error.mark?.line === "number"
      ? // `mark.line` counts from 0 inside the block, which starts on line 2
        // of the file, under the opening `---`.
        error.mark.line + 2
      : null;
  return (
    `SKILL.md frontmatter is not valid YAML${line === null ? "" : ` (line ${line})`}. ` +
    'If a value contains a colon or starts with a special character, wrap it in quotes, for example `description: "Use when: the user asks"`.'
  );
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
