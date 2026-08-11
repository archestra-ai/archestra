import { ResourceVisibilityScopeSchema } from "@archestra/shared";
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

/**
 * Recurring-pull frequency for a GitHub-synced skill. Non-null on a skill
 * marks it content-read-only and scheduled for background re-pull.
 */
export const SkillGithubSyncIntervalSchema = z.enum(["15m", "1h", "1d"]);
export type SkillGithubSyncInterval = z.infer<
  typeof SkillGithubSyncIntervalSchema
>;

const SkillMetadataSchema = z.record(z.string(), z.string());

/** Columns the skills list can be sorted by. */
export const SkillSortBy = [
  "usageCount",
  "lastUsedAt",
  "name",
  "createdAt",
] as const;
export type SkillSortBy = (typeof SkillSortBy)[number];

export const SelectSkillSchema = createSelectSchema(schema.skillsTable, {
  sourceType: SkillSourceTypeSchema,
  scope: ResourceVisibilityScopeSchema,
  metadata: SkillMetadataSchema,
  // a union (not .nullable()) serializes to OpenAPI as anyOf, which the
  // client generator keeps as `| null` — `nullable: true` on an enum is
  // silently dropped (see connector lastSyncStatus).
  githubSyncInterval: z.union([SkillGithubSyncIntervalSchema, z.null()]),
});

// drizzle-zod uses field overrides verbatim, so `.optional()` is applied here
// to keep defaulted columns optional in insert/update payloads. `latestVersion`
// is owned by `SkillModel` (set on create, bumped on fork), so it is omitted
// from external insert/update payloads.
export const InsertSkillSchema = createInsertSchema(schema.skillsTable, {
  sourceType: SkillSourceTypeSchema.optional(),
  scope: ResourceVisibilityScopeSchema.optional(),
  metadata: SkillMetadataSchema.optional(),
  templated: z.boolean().optional(),
  githubSyncInterval: SkillGithubSyncIntervalSchema.nullable().optional(),
}).omit({
  id: true,
  latestVersion: true,
  usageCount: true,
  lastUsedAt: true,
  // derived from the frontmatter columns and the body by `SkillModel`; a
  // caller-supplied value would advertise a digest over bytes nobody stored.
  frontmatterBlob: true,
  digest: true,
  // sync bookkeeping is system-owned (stamped by the sync worker).
  lastSyncedAt: true,
  lastSyncError: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateSkillSchema = createUpdateSchema(schema.skillsTable, {
  sourceType: SkillSourceTypeSchema.optional(),
  scope: ResourceVisibilityScopeSchema.optional(),
  metadata: SkillMetadataSchema.optional(),
  templated: z.boolean().optional(),
  githubSyncInterval: SkillGithubSyncIntervalSchema.nullable().optional(),
}).omit({
  id: true,
  organizationId: true,
  latestVersion: true,
  usageCount: true,
  lastUsedAt: true,
  // model-owned, same as on insert.
  frontmatterBlob: true,
  digest: true,
  // sync state changes only through dedicated model methods
  // (setGithubSync / markGithubSyncResult), never a generic update.
  githubSyncInterval: true,
  githubSyncRef: true,
  githubAppConfigId: true,
  githubPatId: true,
  lastSyncedAt: true,
  lastSyncError: true,
  createdAt: true,
  updatedAt: true,
});

export const SelectSkillVersionSchema = createSelectSchema(
  schema.skillVersionsTable,
);
export const InsertSkillVersionSchema = createInsertSchema(
  schema.skillVersionsTable,
).omit({
  id: true,
  createdAt: true,
});

/**
 * List projection of a version: everything but the SKILL.md body, so history
 * lists stay cheap while get-one carries the full content and files.
 */
export const SkillVersionMetadataSchema = SelectSkillVersionSchema.omit({
  content: true,
});

export const SelectSkillVersionFileSchema = createSelectSchema(
  schema.skillVersionFilesTable,
  {
    kind: SkillFileKindSchema,
    encoding: SkillFileEncodingSchema,
  },
);
export const InsertSkillVersionFileSchema = createInsertSchema(
  schema.skillVersionFilesTable,
  {
    kind: SkillFileKindSchema,
    encoding: SkillFileEncodingSchema,
  },
).omit({
  id: true,
  createdAt: true,
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
  // computed from the bytes being written; never supplied by a caller.
  digest: true,
  createdAt: true,
});

/**
 * A skill row as the REST API returns it.
 *
 * `frontmatterBlob` is dropped: it is a re-serialization of frontmatter the row
 * already carries in its own columns, stored only so the MCP publication path
 * has stable bytes to digest. No API client reads it, and the list endpoint
 * already returns each skill's full `content`.
 */
export const SkillResponseSchema = SelectSkillSchema.omit({
  frontmatterBlob: true,
});

/** A skill with its bundled resource files attached. */
export const SkillWithFilesSchema = SkillResponseSchema.extend({
  files: z.array(SelectSkillFileSchema),
});

/**
 * Per-user activation analytics for one skill over a recent window, built from
 * `skill_usage_events`. `userId: null` groups events with no attributable user;
 * `name: null` marks ids whose `users` row is gone (deleted user) or never
 * existed (synthetic service-account ids).
 */
export const SkillUsageStatisticsSchema = z.object({
  /** Window start (inclusive, ISO timestamp); events before it are excluded. */
  since: z.string(),
  users: z.array(
    z.object({
      userId: z.string().nullable(),
      name: z.string().nullable(),
      total: z.number(),
    }),
  ),
  /** Daily activation counts per user; days without activity are omitted. */
  daily: z.array(
    z.object({
      /** UTC calendar day, `YYYY-MM-DD`. */
      date: z.string(),
      userId: z.string().nullable(),
      count: z.number(),
    }),
  ),
});

export type Skill = z.infer<typeof SelectSkillSchema>;

/**
 * A skill row without its body — what the MCP publication path resolves over.
 *
 * `content` is the largest column on the table and the gateway's listing,
 * directory-read and `skills/get` surfaces never render it, so the queries
 * backing them project it away. Only a manifest read needs a body, and it
 * fetches the one it needs (`SkillModel.findManifestSourceById`).
 */
export type PublishableSkill = Omit<Skill, "content">;

/**
 * Every column a `SKILL.md` is composed from, as one row.
 *
 * The published blob and the fields it was serialized from travel together on
 * purpose: composing a manifest from a blob read at one moment and a body read
 * at another yields bytes that were never a committed state of the row, and so
 * match no digest this platform has ever advertised. Whether the manifest comes
 * from `frontmatterBlob` or is rebuilt from the fields (a row predating those
 * columns, or one an invalidating write reset), both halves must come from the
 * same read — see `SkillModel.findManifestSourceById`.
 */
export type SkillManifestSource = Pick<
  Skill,
  | "name"
  | "description"
  | "license"
  | "compatibility"
  | "allowedTools"
  | "metadata"
  | "content"
  | "frontmatterBlob"
  | "digest"
>;
export type SkillUsageStatistics = z.infer<typeof SkillUsageStatisticsSchema>;
export type InsertSkill = z.infer<typeof InsertSkillSchema>;
export type UpdateSkill = z.infer<typeof UpdateSkillSchema>;
export type SkillFile = z.infer<typeof SelectSkillFileSchema>;
export type InsertSkillFile = z.infer<typeof InsertSkillFileSchema>;
export type SkillVersion = z.infer<typeof SelectSkillVersionSchema>;
export type SkillVersionMetadata = z.infer<typeof SkillVersionMetadataSchema>;
export type InsertSkillVersion = z.infer<typeof InsertSkillVersionSchema>;
export type SkillVersionFile = z.infer<typeof SelectSkillVersionFileSchema>;
export type InsertSkillVersionFile = z.infer<
  typeof InsertSkillVersionFileSchema
>;
