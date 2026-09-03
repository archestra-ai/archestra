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

export function parseManifestFields(raw: string): {
  hasName: boolean;
  hasDescription: boolean;
  templated: boolean;
  /** The frontmatter `name` value, unquoted — null when absent. */
  name: string | null;
  /** The frontmatter `description` value, unquoted — null when absent. */
  description: string | null;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = match?.[1] ?? "";
  const nameMatch = frontmatter.match(/^name:\s*(\S.*?)\s*$/m);
  const descriptionMatch = frontmatter.match(/^description:\s*(\S.*?)\s*$/m);
  const name = nameMatch ? unquoteScalar(nameMatch[1]) : null;
  const description = descriptionMatch
    ? unquoteScalar(descriptionMatch[1])
    : null;
  return {
    hasName: Boolean(name?.trim()),
    hasDescription: Boolean(description?.trim()),
    // the backend parser also accepts a quoted "true"; keep the hint in sync
    templated: /^templated:\s*['"]?true['"]?\s*$/m.test(frontmatter),
    name,
    description,
  };
}

/**
 * Write one frontmatter scalar back into a raw manifest, in place.
 *
 * The skill form edits `name` and `description` as ordinary fields while the
 * manifest they live in stays editable right below them, so the write has to
 * be surgical: replace the line if it is there, insert it above the closing
 * fence if the frontmatter exists without it, and open a frontmatter block if
 * the manifest has none at all. Anything coarser (recomposing from parsed
 * fields) would drop the keys this module does not know about, and reformat
 * the body under the author's cursor.
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
  const fieldPattern = new RegExp(`^${field}:.*$`, "m");
  if (fieldPattern.test(manifest)) {
    return manifest.replace(fieldPattern, line);
  }

  const closingFence = manifest.indexOf("\n---", 4);
  if (manifest.startsWith("---\n") && closingFence >= 0) {
    return `${manifest.slice(0, closingFence)}\n${line}${manifest.slice(closingFence)}`;
  }
  return `---\n${line}\n---\n\n${manifest}`;
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
