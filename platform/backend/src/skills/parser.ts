import { load as parseYaml } from "js-yaml";
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
  metadata: Record<string, string>;
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
 * the required `name`/`description` fields.
 */
export function parseSkillManifest(raw: string): ParsedSkill {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
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
      `SKILL.md frontmatter is not valid YAML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (frontmatter === null || typeof frontmatter !== "object") {
    throw new SkillParseError("SKILL.md frontmatter must be a YAML mapping");
  }

  const fields = frontmatter as Record<string, unknown>;
  const name = readString(fields.name);
  const description = readString(fields.description);

  if (!name) {
    throw new SkillParseError("SKILL.md frontmatter is missing `name`");
  }
  if (!description) {
    throw new SkillParseError("SKILL.md frontmatter is missing `description`");
  }

  return {
    name,
    description,
    content: raw.slice(match[0].length).trim(),
    license: readString(fields.license) || null,
    compatibility: readString(fields.compatibility) || null,
    metadata: readStringMap(fields.metadata),
  };
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

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
