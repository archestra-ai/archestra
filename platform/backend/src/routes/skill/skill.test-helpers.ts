import { SkillModel, SkillTeamModel } from "@/models";
import { builtInSkillSourceRef } from "@/skills/built-in-skills";
import type { ResourceVisibilityScope } from "@/types/visibility";

export const MANIFEST = [
  "---",
  "name: pdf-processing",
  "description: Extract text from PDF files.",
  "---",
  "",
  "# PDF Processing",
  "Use pdftotext -layout.",
].join("\n");

/**
 * A SKILL.md manifest with a custom name (org+name must be unique) and
 * optional extra frontmatter lines.
 */
export function manifestNamed(name: string, extraFrontmatter = ""): string {
  return [
    "---",
    `name: ${name}`,
    "description: A scoped skill.",
    extraFrontmatter,
    "---",
    "",
    `# ${name}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A built-in skill written directly through the model layer, carrying the
 * `builtin:<id>` identity token that startup sync stores in `source_ref`.
 */
export async function seedBuiltInSkill(params: {
  organizationId: string;
  name: string;
  builtInSkillId: string;
}) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: null,
      name: params.name,
      description: `${params.name} description`,
      content: `# ${params.name}`,
      metadata: {},
      sourceType: "built_in",
      sourceRef: builtInSkillSourceRef(params.builtInSkillId),
      scope: "org",
    },
    files: [],
  });
  if (!skill) throw new Error("seed failed");
  return skill;
}

/** A github-sourced skill written directly through the model layer. */
export async function seedImportedSkill(params: {
  organizationId: string;
  name: string;
  sourceRef: string;
  scope: ResourceVisibilityScope;
  authorId?: string | null;
  teamIds?: string[];
}) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: params.authorId ?? null,
      name: params.name,
      description: `${params.name} description`,
      content: `# ${params.name}`,
      metadata: {},
      sourceType: "github",
      sourceRef: params.sourceRef,
      scope: params.scope,
    },
    files: [],
  });
  if (!skill) throw new Error("seed failed");
  if (params.teamIds?.length) {
    await SkillTeamModel.syncSkillTeams(skill.id, params.teamIds);
  }
  return skill;
}
