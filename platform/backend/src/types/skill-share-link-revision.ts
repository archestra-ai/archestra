import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Encoding for a single file in a revision payload. `utf8` keeps the JSON
 * small and human-readable for text content; `base64` is used for any byte
 * sequence the user-uploaded skill files may contain (images, archives,
 * etc.). The on-disk replay reverses this back into raw bytes verbatim.
 */
export const RevisionPayloadFileEncodingSchema = z.enum(["utf8", "base64"]);
export type RevisionPayloadFileEncoding = z.infer<
  typeof RevisionPayloadFileEncodingSchema
>;

export const RevisionPayloadFileSchema = z.object({
  /** Repo-relative POSIX path, e.g. `plugins/foo/skills/foo/SKILL.md`. */
  path: z.string().min(1),
  /** File mode in the git tree: `100644` (regular) or `100755` (executable). */
  mode: z.enum(["100644", "100755"]),
  content: z.string(),
  encoding: RevisionPayloadFileEncodingSchema,
});
export type RevisionPayloadFile = z.infer<typeof RevisionPayloadFileSchema>;

export const RevisionPayloadSchema = z.object({
  files: z.array(RevisionPayloadFileSchema),
});
export type RevisionPayload = z.infer<typeof RevisionPayloadSchema>;

export const SelectSkillShareLinkRevisionSchema = createSelectSchema(
  schema.skillShareLinkRevisionsTable,
);

export const InsertSkillShareLinkRevisionSchema = createInsertSchema(
  schema.skillShareLinkRevisionsTable,
).omit({
  id: true,
  createdAt: true,
});

export type SkillShareLinkRevision = z.infer<
  typeof SelectSkillShareLinkRevisionSchema
>;
export type InsertSkillShareLinkRevision = z.infer<
  typeof InsertSkillShareLinkRevisionSchema
>;
