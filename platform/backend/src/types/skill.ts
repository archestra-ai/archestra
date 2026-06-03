import { ResourceVisibilityScopeSchema } from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * How a skill entered the system. `built_in` skills are shipped by Archestra
 * and reconciled on startup; they are editable but can be reset to the shipped
 * definition.
 */
export const SkillSourceTypeSchema = z.enum(["manual", "github", "built_in"]);
export type SkillSourceType = z.infer<typeof SkillSourceTypeSchema>;

/**
 * Coarse classification of a bundled resource file, derived from its path
 * prefix (`references/`, `scripts/`, `assets/`).
 */
export const SkillFileKindSchema = z.enum(["reference", "script", "asset"]);
export type SkillFileKind = z.infer<typeof SkillFileKindSchema>;

/**
 * How `content` is encoded. UTF-8 for text; base64 for binary assets so the
 * raw bytes can be reconstructed when redistributing a skill.
 */
export const SkillFileEncodingSchema = z.enum(["utf8", "base64"]);
export type SkillFileEncoding = z.infer<typeof SkillFileEncodingSchema>;

const SkillMetadataSchema = z.record(z.string(), z.string());

export const SelectSkillSchema = createSelectSchema(schema.skillsTable, {
  sourceType: SkillSourceTypeSchema,
  scope: ResourceVisibilityScopeSchema,
  metadata: SkillMetadataSchema,
});

// drizzle-zod uses field overrides verbatim, so `.optional()` is applied here
// to keep defaulted columns optional in insert/update payloads.
export const InsertSkillSchema = createInsertSchema(schema.skillsTable, {
  sourceType: SkillSourceTypeSchema.optional(),
  scope: ResourceVisibilityScopeSchema.optional(),
  metadata: SkillMetadataSchema.optional(),
  templated: z.boolean().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateSkillSchema = createUpdateSchema(schema.skillsTable, {
  sourceType: SkillSourceTypeSchema.optional(),
  scope: ResourceVisibilityScopeSchema.optional(),
  metadata: SkillMetadataSchema.optional(),
  templated: z.boolean().optional(),
}).omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
});

export const SelectSkillFileSchema = createSelectSchema(
  schema.skillFilesTable,
  {
    kind: SkillFileKindSchema,
    encoding: SkillFileEncodingSchema,
  },
);

export const InsertSkillFileSchema = createInsertSchema(
  schema.skillFilesTable,
  {
    kind: SkillFileKindSchema,
    encoding: SkillFileEncodingSchema.optional(),
  },
).omit({
  id: true,
  createdAt: true,
});

/** A skill with its bundled resource files attached. */
export const SkillWithFilesSchema = SelectSkillSchema.extend({
  files: z.array(SelectSkillFileSchema),
});

export type Skill = z.infer<typeof SelectSkillSchema>;
export type InsertSkill = z.infer<typeof InsertSkillSchema>;
export type UpdateSkill = z.infer<typeof UpdateSkillSchema>;
export type SkillFile = z.infer<typeof SelectSkillFileSchema>;
export type InsertSkillFile = z.infer<typeof InsertSkillFileSchema>;
