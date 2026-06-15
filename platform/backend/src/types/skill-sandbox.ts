import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/** Discriminator for an ordered sandbox replay event. */
export const SkillSandboxReplayEventKindSchema = z.enum([
  "command",
  "upload",
  "skill_mount",
]);
export type SkillSandboxReplayEventKind = z.infer<
  typeof SkillSandboxReplayEventKindSchema
>;

/** Role of a sandbox file: an uploaded input or an exported output artifact. */
export const SkillSandboxFileKindSchema = z.enum(["upload", "artifact"]);
export type SkillSandboxFileKind = z.infer<typeof SkillSandboxFileKindSchema>;

/** Where a sandbox file's bytes live: Postgres bytea or an external filesystem. */
export const SkillSandboxFileStorageProviderSchema = z.enum([
  "db",
  "filesystem",
]);
export type SkillSandboxFileStorageProvider = z.infer<
  typeof SkillSandboxFileStorageProviderSchema
>;

/**
 * How an upload entered the sandbox (nullable column). `x_file` = copied from
 * the user's persistent X-Files storage; these uploads surface in the
 * conversation Files panel.
 */
export const SandboxFileOriginSchema = z.enum(["x_file"]);
export type SandboxFileOrigin = z.infer<typeof SandboxFileOriginSchema>;

export const SelectSkillSandboxSchema = createSelectSchema(
  schema.skillSandboxesTable,
);
export const InsertSkillSandboxSchema = createInsertSchema(
  schema.skillSandboxesTable,
).omit({
  id: true,
  createdAt: true,
});

export const SelectSkillSandboxCommandSchema = createSelectSchema(
  schema.skillSandboxCommandsTable,
);
export const InsertSkillSandboxCommandSchema = createInsertSchema(
  schema.skillSandboxCommandsTable,
).omit({
  id: true,
  createdAt: true,
});

export const SelectSkillSandboxFileSchema = createSelectSchema(
  schema.skillSandboxFilesTable,
  {
    kind: SkillSandboxFileKindSchema,
    origin: SandboxFileOriginSchema.nullable(),
  },
);
export const InsertSkillSandboxFileSchema = createInsertSchema(
  schema.skillSandboxFilesTable,
  {
    kind: SkillSandboxFileKindSchema,
    origin: SandboxFileOriginSchema.nullable().optional(),
  },
).omit({
  id: true,
  createdAt: true,
});

export const SelectSkillSandboxFolderSchema = createSelectSchema(
  schema.skillSandboxFoldersTable,
);
export type SkillSandboxFolder = z.infer<typeof SelectSkillSandboxFolderSchema>;

export const SelectSkillSandboxReplayEventSchema = createSelectSchema(
  schema.skillSandboxReplayEventsTable,
  { kind: SkillSandboxReplayEventKindSchema },
);
export const InsertSkillSandboxReplayEventSchema = createInsertSchema(
  schema.skillSandboxReplayEventsTable,
  { kind: SkillSandboxReplayEventKindSchema },
).omit({
  id: true,
  createdAt: true,
});

export const SelectSkillSandboxSkillMountSchema = createSelectSchema(
  schema.skillSandboxSkillMountsTable,
);
export const InsertSkillSandboxSkillMountSchema = createInsertSchema(
  schema.skillSandboxSkillMountsTable,
).omit({
  id: true,
  createdAt: true,
});

export type SkillSandbox = z.infer<typeof SelectSkillSandboxSchema>;
export type InsertSkillSandbox = z.infer<typeof InsertSkillSandboxSchema>;
export type SkillSandboxCommand = z.infer<
  typeof SelectSkillSandboxCommandSchema
>;
export type InsertSkillSandboxCommand = z.infer<
  typeof InsertSkillSandboxCommandSchema
>;
export type SkillSandboxFile = z.infer<typeof SelectSkillSandboxFileSchema>;
export type InsertSkillSandboxFile = z.infer<
  typeof InsertSkillSandboxFileSchema
>;

/**
 * One row of a user's artifact listing as the model returns it. `filename` is
 * already derived (`original_name ?? basename(path)`); `storageProvider` /
 * `objectKey` let the filesystem provider match a row to an on-disk file.
 */
export type SandboxArtifactRow = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  storageProvider: SkillSandboxFileStorageProvider;
  objectKey: string | null;
  folderId: string | null;
  /** Resolved folder name (left-joined); null for root files. */
  folderName: string | null;
};

/**
 * One PFS folder as the X-Files surfaces render it. `id` is null for a
 * directory that exists on disk without a `skill_sandbox_folders` row (made by
 * hand in the storage folder).
 */
export const SandboxFolderListItemSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string(),
  createdAt: z.date(),
});
export type SandboxFolderListItem = z.infer<typeof SandboxFolderListItemSchema>;

/**
 * One file as the X-Files surfaces render it. `id` is the artifact row id used
 * for download via `/api/skill-sandbox/artifacts/:id`; it is null (and
 * `downloadable` false) for filesystem files that were added by hand and have
 * no row.
 */
export const SandboxFileListItemSchema = z.object({
  id: z.string().uuid().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.date(),
  downloadable: z.boolean(),
  /** PFS folder the file sits in; null for root files. */
  folder: z.string().nullable(),
});

export type SandboxFileListItem = z.infer<typeof SandboxFileListItemSchema>;
export type SkillSandboxReplayEvent = z.infer<
  typeof SelectSkillSandboxReplayEventSchema
>;
export type InsertSkillSandboxReplayEvent = z.infer<
  typeof InsertSkillSandboxReplayEventSchema
>;
export type SkillSandboxSkillMount = z.infer<
  typeof SelectSkillSandboxSkillMountSchema
>;
export type InsertSkillSandboxSkillMount = z.infer<
  typeof InsertSkillSandboxSkillMountSchema
>;

/**
 * Branded sandbox id so callers cannot accidentally pass a raw uuid string
 * where the runtime expects a sandbox handle.
 */
export type SandboxId = string & { readonly __brand: "SandboxId" };

export function asSandboxId(id: string): SandboxId {
  return id as SandboxId;
}
