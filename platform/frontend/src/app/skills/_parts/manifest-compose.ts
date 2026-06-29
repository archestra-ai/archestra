/**
 * Pure SKILL.md manifest helpers for the editor: recompose a manifest from a
 * skill's structured fields, and a light frontmatter scan for editor hints.
 * The backend parser (`skills/parser.ts`) stays authoritative for semantics.
 */

export function composeManifest(skill: {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
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
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = match?.[1] ?? "";
  return {
    hasName: /^name:\s*\S/m.test(frontmatter),
    hasDescription: /^description:\s*\S/m.test(frontmatter),
    // the backend parser also accepts a quoted "true"; keep the hint in sync
    templated: /^templated:\s*['"]?true['"]?\s*$/m.test(frontmatter),
  };
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}
