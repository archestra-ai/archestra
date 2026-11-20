import type { ArchestraToolShortName } from "@archestra/shared";
import { load as parseYaml } from "js-yaml";

export type SkillApprovalView = {
  name: string;
  description: string;
  instructions: string;
  currentName?: string;
  metadata?: string;
  additionalArguments?: string;
  originalArguments: string;
};

/**
 * A display-only view of skill authoring arguments. The backend remains the
 * manifest validator; malformed input keeps the generic request display.
 * Parse the original JSON, not the tool display's revived JSON strings, so
 * neither a manifest nor any other argument is rewritten for approval.
 */
export function getSkillApprovalView(
  toolName: ArchestraToolShortName | null,
  rawArguments: string | undefined,
): SkillApprovalView | null {
  if (
    (toolName !== "create_skill" && toolName !== "update_skill") ||
    !rawArguments
  ) {
    return null;
  }

  try {
    const input: unknown = JSON.parse(rawArguments);
    if (!isRecord(input) || typeof input.content !== "string") return null;
    const manifest = input.content.replace(/^\uFEFF/, "");
    const match = manifest.match(
      /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/,
    );
    if (!match) return null;
    const fields: unknown = parseYaml(match[1]);
    if (
      !isRecord(fields) ||
      typeof fields.name !== "string" ||
      !fields.name.trim() ||
      typeof fields.description !== "string" ||
      !fields.description.trim()
    ) {
      return null;
    }
    if (
      toolName === "update_skill" &&
      (typeof input.name !== "string" || !input.name.trim())
    ) {
      return null;
    }

    const { name, description, ...metadata } = fields;
    const additionalArguments = Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          key !== "content" && !(toolName === "update_skill" && key === "name"),
      ),
    );
    return {
      name: name.trim(),
      description: description.trim(),
      instructions: manifest.slice(match[0].length).trim(),
      ...(toolName === "update_skill" && typeof input.name === "string"
        ? { currentName: input.name }
        : {}),
      ...(Object.keys(metadata).length
        ? { metadata: JSON.stringify(metadata, null, 2) }
        : {}),
      ...(Object.keys(additionalArguments).length
        ? { additionalArguments: JSON.stringify(additionalArguments, null, 2) }
        : {}),
      originalArguments: rawArguments,
    };
  } catch {
    // Includes invalid YAML/JSON and cyclic YAML aliases that cannot be
    // represented faithfully in the metadata view.
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
