/**
 * Pure SKILL.md manifest helpers: recompose a manifest from a skill's
 * structured fields, and a light frontmatter scan for editor hints.
 *
 * The API stores a skill's frontmatter as columns and its body as `content`,
 * but takes a whole SKILL.md on write — so anything that writes a skill
 * (the editor, restoring a version) has to compose one first. The backend
 * parser (`skills/parser.ts`) stays authoritative for semantics.
 *
 * That makes the field list below a copy of the backend's, and the copy is only
 * half-checked: renaming a frontmatter column breaks the call sites, which
 * spread a skill into `composeManifest`, but *adding* one does not. A new
 * frontmatter field has to be added here too, or every save and every restore
 * silently drops it.
 */

import { load as parseYaml } from "js-yaml";

export function composeManifest(skill: {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
  agentName: string | null;
  templated: boolean;
  metadata: Record<string, string>;
  content: string;
}): string {
  const lines = [
    "---",
    `name: ${yamlScalar(skill.name)}`,
    `description: ${yamlScalar(skill.description)}`,
  ];
  if (skill.license) lines.push(`license: ${yamlScalar(skill.license)}`);
  if (skill.compatibility) {
    lines.push(`compatibility: ${yamlScalar(skill.compatibility)}`);
  }
  if (skill.allowedTools) {
    lines.push(`allowed-tools: ${yamlScalar(skill.allowedTools)}`);
  }
  if (skill.agentName) lines.push(`agent: ${yamlScalar(skill.agentName)}`);
  if (skill.templated) lines.push("templated: true");
  const metadataEntries = Object.entries(skill.metadata ?? {});
  if (metadataEntries.length > 0) {
    lines.push("metadata:");
    for (const [key, value] of metadataEntries) {
      lines.push(`  ${yamlScalar(key)}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---", "", skill.content);
  return lines.join("\n");
}

/**
 * The `name`, `description` and `templated` a manifest's frontmatter holds,
 * for the form's fields and hints.
 *
 * Read as YAML, as the backend does, so the fields show the values a save
 * would store: a comment after a value is not part of it, and a description
 * written over several lines (`description: >-`) is its text, not its
 * indicator. While the frontmatter is not valid YAML, which it often is not
 * between two keystrokes, the lines are scanned instead, so the fields keep
 * what they showed.
 */
export function parseManifestFields(raw: string): {
  hasName: boolean;
  hasDescription: boolean;
  templated: boolean;
  /** The frontmatter `name` value, unquoted — null when absent. */
  name: string | null;
  /** The frontmatter `description` value, unquoted — null when absent. */
  description: string | null;
} {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = match?.[1] ?? "";
  const read = readFrontmatter(frontmatter) ?? scanFrontmatter(frontmatter);
  return {
    hasName: Boolean(read.name?.trim()),
    hasDescription: Boolean(read.description?.trim()),
    ...read,
  };
}

/**
 * Write one frontmatter scalar back into a raw manifest, in place.
 *
 * The skill form edits `name` and `description` as ordinary fields while the
 * manifest they live in stays editable right below them, so the write has to
 * be surgical: replace the value if the key is there, insert the key above
 * the closing fence if the frontmatter exists without it, and open a
 * frontmatter block if the manifest has none at all. Anything coarser
 * (recomposing from parsed fields) would drop the keys this module does not
 * know about, and reformat the body under the author's cursor.
 *
 * The whole value is replaced, and a value can run over several lines: a
 * block (`description: >-`) or a quoted text continued on indented lines.
 * Replacing only the key's own line would leave those lines behind, under a
 * value they no longer belong to.
 */
export function setManifestFrontmatterField({
  manifest,
  field,
  value,
}: {
  manifest: string;
  field: "name" | "description";
  value: string;
}): string {
  const line = `${field}: ${yamlScalar(value)}`;
  const block = manifest.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!block) return `---\n${line}\n---\n\n${manifest}`;

  const [whole, open, frontmatter, close] = block;
  const rest = manifest.slice(whole.length);
  const lines = frontmatter.split("\n");
  const at = lines.findIndex((entry) => entry.startsWith(`${field}:`));
  if (at < 0) return `${open}${frontmatter}\n${line}${close}${rest}`;

  // The value's last line: the last indented line before the next key. Blank
  // lines inside a block belong to it; those after it do not.
  let last = at;
  for (let index = at + 1; index < lines.length; index++) {
    if (/^[ \t]+\S/.test(lines[index])) last = index;
    else if (lines[index].trim() !== "") break;
  }
  const carriageReturn = lines[last].endsWith("\r") ? "\r" : "";
  lines.splice(at, last - at + 1, `${line}${carriageReturn}`);
  return `${open}${lines.join("\n")}${close}${rest}`;
}

/**
 * What a save would drop from the manifest's frontmatter.
 *
 * A skill's frontmatter is stored as columns, one per field listed in
 * `STORED_FRONTMATTER_KEYS`, and `metadata` as a flat map of text. Anything
 * else an author writes there is parsed and then not kept: a key the columns
 * have no place for (`model`, `argument-hint`) is gone on the next load, and a
 * nested value under `metadata` comes back as one line of JSON text. Until the
 * storage keeps the whole block, the form says so before the save instead of
 * after the reload.
 *
 * Empty for frontmatter that is not valid YAML: the save is refused then, with
 * its own message.
 */
export function findFrontmatterNotKept(manifest: string): {
  /** Top-level keys with no column to be stored in. */
  keys: string[];
  /** `metadata` entries whose value is a map or a list. */
  nestedMetadataKeys: string[];
} {
  const nothing = { keys: [], nestedMetadataKeys: [] };
  const match = manifest.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return nothing;
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]);
  } catch {
    return nothing;
  }
  if (!isPlainMap(frontmatter)) return nothing;
  return {
    keys: Object.keys(frontmatter).filter(
      (key) => !STORED_FRONTMATTER_KEYS.has(key),
    ),
    nestedMetadataKeys: isPlainMap(frontmatter.metadata)
      ? Object.entries(frontmatter.metadata)
          .filter(([, value]) => value !== null && typeof value === "object")
          .map(([key]) => key)
      : [],
  };
}

/** The frontmatter fields the backend parser (`skills/parser.ts`) stores. */
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

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface FrontmatterFields {
  name: string | null;
  description: string | null;
  templated: boolean;
}

/** The fields as YAML reads them, or null for frontmatter it cannot read. */
function readFrontmatter(frontmatter: string): FrontmatterFields | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch {
    return null;
  }
  if (!isPlainMap(parsed)) return null;
  const text = (value: unknown) =>
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : null;
  return {
    name: text(parsed.name),
    description: text(parsed.description),
    // the backend parser also accepts a quoted "true"; keep the hint in sync
    templated: parsed.templated === true || parsed.templated === "true",
  };
}

/** The same fields from the lines themselves, for frontmatter mid-edit. */
function scanFrontmatter(frontmatter: string): FrontmatterFields {
  const nameMatch = frontmatter.match(/^name:\s*(\S.*?)\s*$/m);
  const descriptionMatch = frontmatter.match(/^description:\s*(\S.*?)\s*$/m);
  return {
    name: nameMatch ? unquoteScalar(nameMatch[1]) : null,
    description: descriptionMatch ? unquoteScalar(descriptionMatch[1]) : null,
    templated: /^templated:\s*['"]?true['"]?\s*$/m.test(frontmatter),
  };
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function unquoteScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}
