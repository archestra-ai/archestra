import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * How a skill entered the system.
 */
export const SkillSourceTypeSchema = z.enum(["manual", "github"]);
export type SkillSourceType = z.infer<typeof SkillSourceTypeSchema>;

/**
 * Coarse classification of a bundled resource file, derived from its path
 * prefix (`references/`, `scripts/`, `assets/`).
 */
export const SkillFileKindSchema = z.enum(["reference", "script", "asset"]);
export type SkillFileKind = z.infer<typeof SkillFileKindSchema>;

const SkillMetadataSchema = z.record(z.string(), z.string());

export const SelectSkillSchema = createSelectSchema(schema.skillsTable, {
  sourceType: SkillSourceTypeSchema,
  metadata: SkillMetadataSchema,
});

// drizzle-zod uses field overrides verbatim, so `.optional()` is applied here
// to keep defaulted columns optional in insert/update payloads.
export const InsertSkillSchema = createInsertSchema(schema.skillsTable, {
  sourceType: SkillSourceTypeSchema.optional(),
  metadata: SkillMetadataSchema.optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateSkillSchema = createUpdateSchema(schema.skillsTable, {
  sourceType: SkillSourceTypeSchema.optional(),
  metadata: SkillMetadataSchema.optional(),
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
  },
);

export const InsertSkillFileSchema = createInsertSchema(
  schema.skillFilesTable,
  {
    kind: SkillFileKindSchema,
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
