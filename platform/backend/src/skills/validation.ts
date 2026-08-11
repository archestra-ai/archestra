import { z } from "zod";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CONTENT_CHARS,
} from "@/skills/github-import";
import { deriveSkillFileKind, type ParsedSkill } from "@/skills/parser";
import {
  type InsertSkill,
  SkillFileEncodingSchema,
  type UpdateSkill,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

/**
 * A submitted resource file. Shared by the REST routes and the MCP skill
 * tools so both surfaces validate (and describe) files identically.
 */
export const SkillFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine(
        // Deliberately no stricter than it has ever been. Publishing over MCP
        // wants more (see `isPublishableSkillFilePath`), but an existing skill's
        // file set is resubmitted wholesale on every edit, so tightening this
        // would turn a skill stored under an older rule into one its owner can
        // no longer save. Such a skill is withheld from the gateway instead.
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
  })
  .superRefine((file, ctx) => {
    // Base64 content must be canonical (RFC 4648: padded, no whitespace, no
    // trailing bits) — the exact form `Buffer.toString("base64")` emits, which
    // is what every platform writer produces. Anything looser is rejected here
    // rather than digested: decoders disagree on non-canonical input
    // (`QQ==QQ==` is two bytes to Postgres, one to Node, an error to Python),
    // so a digest over it could never verify for every client. Unlike the
    // `path` rule above this CAN be strict, because no write surface has ever
    // stored a non-canonical spelling.
    if ((file.encoding ?? "utf8") !== "base64") return;
    if (
      Buffer.from(file.content, "base64").toString("base64") !== file.content
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "content must be canonical base64 (padded, no whitespace) when encoding is base64",
        path: ["content"],
      });
    }
  });

/**
 * Whether a stored resource-file path can be named by a `skill://` URI that
 * round-trips — the bar for publishing the file over the MCP gateway.
 *
 * Stricter than what storage accepts, and deliberately checked only at
 * publication: a skill whose files break this keeps working everywhere else and
 * is simply withheld from the gateway (with a warning), rather than becoming
 * unsaveable for its owner.
 */
export function isPublishableSkillFilePath(path: string): boolean {
  return hasRoundTrippableSegments(path);
}

/**
 * Whether a skill's stored paths can coexist as one directory tree — no path
 * may be a parent directory of another.
 *
 * Storage keeps a flat list of paths, so nothing stops a skill holding both
 * `templates` and `templates/eu.md`. Published, that names one URI twice: a
 * file with its own digest, and the directory above it. A host materializing
 * the skill cannot create both, and git cannot even represent the shape, so
 * only API- or UI-authored rows reach it.
 *
 * A set-level rule, hence separate from {@link isPublishableSkillFilePath}:
 * every path here is individually fine. Checked at publication and nowhere
 * else, like the rest of them — such a skill keeps working everywhere in
 * Archestra and is simply withheld from the gateway.
 */
export function hasPublishableFilePathSet(paths: string[]): boolean {
  const all = new Set(paths);

  for (const path of paths) {
    // Walk the path's own parents rather than comparing every pair: a skill
    // is capped at 500 files, but the pairwise compare is still quadratic for
    // no reason when a lookup per segment answers the same question.
    let cut = path.lastIndexOf("/");
    while (cut > 0) {
      if (all.has(path.slice(0, cut))) return false;
      cut = path.lastIndexOf("/", cut - 1);
    }
  }

  return true;
}

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
      "`agent`, `templated`, `metadata`), followed by the Markdown instruction " +
      "body. Set `templated: true` to render the body through Handlebars (e.g. " +
      "`{{user.name}}`) at activation. `allowed-tools` is a space-separated " +
      "list of tools the skill is pre-approved to use. `agent` names an agent " +
      "the skill runs in — when set, activating the skill delegates it to that " +
      "agent instead of loading the instructions into the caller's context.",
  );

type SkillManifestFieldKey =
  | "name"
  | "description"
  | "content"
  | "license"
  | "compatibility"
  | "allowedTools"
  | "agentName"
  | "templated"
  | "metadata";

/** Manifest-derived columns valid in both insert and update rows, so a schema
 * divergence is caught here rather than at a spread site. */
type SkillManifestFields = Pick<InsertSkill, SkillManifestFieldKey> &
  Pick<UpdateSkill, SkillManifestFieldKey>;

/**
 * The skill-row columns every write surface (REST create/update, agent
 * conversion, MCP create_skill/update_skill) copies from a parsed manifest or
 * draft, so a new manifest field is mapped in one place. The REST routes
 * override `allowedTools` after the spread when the request body provides an
 * explicit list.
 */
export function toSkillInsertFields(draft: ParsedSkill): SkillManifestFields {
  return {
    name: draft.name,
    description: draft.description,
    content: draft.content,
    license: draft.license,
    compatibility: draft.compatibility,
    allowedTools: draft.allowedTools,
    agentName: draft.agentName,
    templated: draft.templated,
    metadata: draft.metadata,
  };
}

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

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Every segment must be a real name: an empty segment (leading or trailing
 * `/`, `a//b`) or a `.` segment produces a path that can never round-trip
 * through the skill:// URIs the gateway publishes, and `..` is directory
 * traversal.
 */
function hasRoundTrippableSegments(path: string): boolean {
  return (
    path.length > 0 &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}
