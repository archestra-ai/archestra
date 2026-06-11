import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  SandboxFileOrigin,
  SkillSandboxFileKind,
  SkillSandboxFileStorageProvider,
} from "@/types/skill-sandbox";
import skillSandboxesTable from "./skill-sandbox";
import skillSandboxFoldersTable from "./skill-sandbox-folder";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Every file byte that lives in a sandbox, in one role-tagged table (S3-like:
 * a key/value blob plus metadata). `kind` distinguishes the two roles:
 *
 *   - `upload` — an INPUT written via `upload_file`. Its bytes become part of
 *     the sandbox replay recipe: each upload is referenced from exactly one
 *     ordered `skill_sandbox_replay_events` row (composite FK on `kind`), so a
 *     file uploaded between two commands materializes at that point and is never
 *     visible to a command that ran before it.
 *   - `artifact` — an OUTPUT copied out of a materialized container via
 *     `download_file`. Sandboxes are ephemeral, so artifacts are how generated
 *     files survive a Dagger cache flush.
 *
 * Bytes live in `data` (when `storage_provider = 'db'`) or on the filesystem
 * under `object_key` (when `storage_provider = 'filesystem'`), per the operator
 * config; mixed-mode rows are supported permanently.
 */
const skillSandboxFilesTable = pgTable(
  "skill_sandbox_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<SkillSandboxFileKind>().notNull(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
    /** Absolute path inside the container the file is written to / exported from. */
    path: text("path").notNull(),
    mimeType: text("mime_type").notNull(),
    /** Caller-provided source filename; uploads only. */
    originalName: text("original_name"),
    /**
     * Generic per-sandbox upload dedup key (plain uuid, no FK) — the partial
     * unique index below makes an upload carrying one idempotent across
     * processes. Two producers set it:
     *   - chat-attachment staging: the source `conversation_attachments` row id
     *     (the attachment may be soft-deleted while its staged bytes live on).
     *   - lifecycle hooks: a content-addressed id so a hook script is uploaded
     *     once per (sandbox, hook, content) instead of every fire (see the hook
     *     runner's `dedupeId`).
     * The two producers use disjoint uuid spaces (attachment ids are v4, hook
     * dedup ids v5), so they never collide. Null for `upload_file`-tool uploads
     * and for artifacts.
     */
    sourceAttachmentId: uuid("source_attachment_id"),
    sizeBytes: integer("size_bytes").notNull(),
    /**
     * Bytes when storage_provider = 'db'. Null when they live externally —
     * then `object_key` points at them instead (XOR enforced below).
     */
    data: bytea("data"),
    /** Which storage backend holds this row's bytes. */
    storageProvider: text("storage_provider")
      .$type<SkillSandboxFileStorageProvider>()
      .notNull()
      .default("db"),
    /** Path relative to the configured storage root; filesystem rows only. */
    objectKey: text("object_key"),
    /**
     * PFS folder the artifact was exported into; artifacts only. SET NULL on
     * folder delete (defensive — no folder delete API yet); the on-disk
     * location is still recorded by `object_key` in filesystem mode.
     */
    folderId: uuid("folder_id").references(() => skillSandboxFoldersTable.id, {
      onDelete: "set null",
    }),
    /**
     * How an upload entered the sandbox: 'x_file' = copied from the user's
     * persistent X-Files storage (these surface in the conversation Files
     * panel). Null for artifacts and for ordinary uploads.
     */
    origin: text("origin").$type<SandboxFileOrigin>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandbox_files_sandbox_id_idx").on(table.sandboxId),
    index("skill_sandbox_files_sandbox_kind_idx").on(
      table.sandboxId,
      table.kind,
    ),
    // parent key for the replay-event composite FK: lets a replay event point
    // only at `kind = 'upload'` rows (see skill-sandbox-replay-event.ts).
    unique("skill_sandbox_files_id_kind_uidx").on(table.id, table.kind),
    // one staged upload per (sandbox, attachment): makes auto-staging idempotent
    // at the DB level (ON CONFLICT DO NOTHING) even across backend processes,
    // where the in-memory per-sandbox queue cannot coordinate.
    uniqueIndex("skill_sandbox_files_sandbox_attachment_uidx")
      .on(table.sandboxId, table.sourceAttachmentId)
      .where(sql`${table.sourceAttachmentId} IS NOT NULL`),
    // exactly one byte location per row: bytea for 'db', object_key for
    // 'filesystem'. A row violating this is unreadable, so reject at write time.
    check(
      "skill_sandbox_files_storage_payload_chk",
      sql`(
        (${table.storageProvider} = 'db' AND ${table.data} IS NOT NULL AND ${table.objectKey} IS NULL)
        OR (${table.storageProvider} = 'filesystem' AND ${table.objectKey} IS NOT NULL AND ${table.data} IS NULL)
      )`,
    ),
  ],
);

export default skillSandboxFilesTable;
