import { z } from "zod";
import { isUniqueConstraintError } from "@/utils/db";

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
