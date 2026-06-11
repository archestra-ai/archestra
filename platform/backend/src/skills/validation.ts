import { z } from "zod";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CONTENT_CHARS,
} from "@/skills/github-import";
import { deriveSkillFileKind } from "@/skills/parser";
import { SkillFileEncodingSchema } from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

/**
 * A submitted resource file. Shared by the REST routes and the MCP skill
 * tools so both surfaces validate (and describe) files identically.
 */
export const SkillFileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine(
      (p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".."),
      {
        message:
          "path must be relative and must not contain directory traversal sequences",
      },
    )
    .describe("Resource path, e.g. references/API.md or scripts/run.py"),
  content: z
    .string()
    .max(MAX_SKILL_FILE_CONTENT_CHARS)
    .describe("Text content of the file"),
  encoding: SkillFileEncodingSchema.optional(),
});

/**
 * The raw SKILL.md manifest text accepted by create/update on both the REST
 * routes and the MCP skill tools.
 */
export const SkillManifestContentSchema = z
  .string()
  .min(1)
  .max(MAX_SKILL_FILE_BYTES)
  .describe(
    "A complete SKILL.md manifest: a YAML frontmatter block with `name` and " +
      "`description` (and optional `license`, `compatibility`, `allowed-tools`, " +
      "`templated`, `metadata`), followed by the Markdown instruction body. Set " +
      "`templated: true` to render the body through Handlebars (e.g. " +
      "`{{user.name}}`) at activation. `allowed-tools` is a space-separated " +
      "list of tools the skill is pre-approved to use.",
  );

/** Classify each submitted resource file by its path prefix. */
export function toSkillFiles(files: z.infer<typeof SkillFileInputSchema>[]) {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
    encoding: file.encoding ?? "utf8",
    kind: deriveSkillFileKind(file.path),
  }));
}

/**
 * Reject duplicate resource paths at input. Resource paths are unique per skill
 * (the `skill_files` unique index), so a repeated path would otherwise surface
 * as an opaque DB unique violation from createWithFiles/updateWithFiles. Shared
 * by the REST routes and the MCP skill tools so both surfaces fail the same way.
 */
export function refineUniqueFilePaths(
  files: { path: string }[] | undefined,
  ctx: z.RefinementCtx,
) {
  if (!files) return;
  const seen = new Set<string>();
  files.forEach((file, index) => {
    if (seen.has(file.path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate resource file path: ${file.path}`,
        path: ["files", index, "path"],
      });
    }
    seen.add(file.path);
  });
}

/**
 * Whether an error is a skill-name unique violation on either visibility
 * namespace (personal-per-author or shared-per-org), as opposed to a team FK or
 * a duplicate resource-file path. Shared by the REST routes and the MCP skill
 * tools so a rename collision maps to a friendly conflict on both surfaces.
 */
export function isSkillNameConflict(error: unknown): boolean {
  return (
    isUniqueConstraintError(error, "skills_org_personal_name_idx") ||
    isUniqueConstraintError(error, "skills_org_shared_name_idx")
  );
}
