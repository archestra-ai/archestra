import { sql } from "drizzle-orm";
import {
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
} from "@/types/skill-sandbox";
import skillSandboxesTable from "./skill-sandbox";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Sandbox INPUT files (`kind = 'upload'`): bytes written via `upload_file`
 * that become part of the sandbox replay recipe. Each upload is referenced
 * from exactly one ordered `skill_sandbox_replay_events` row (composite FK on
 * `kind`), so a file uploaded between two commands materializes at that point
 * and is never visible to a command that ran before it.
 *
 * Uploads are always Postgres bytes (`data`); they must be re-readable on every
 * container rebuild. Persistent OUTPUT files ("My Files", formerly
 * `kind = 'artifact'`) moved to the `files` table — see `database/schemas/file.ts`.
 * The `kind` column is retained (still `'upload'` for every row) because the
 * replay-event composite FK pins to it.
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
    /** Upload bytes; always present (uploads are Postgres-only). */
    data: bytea("data").notNull(),
    /**
     * How an upload entered the sandbox: 'my_file' = copied from the user's
     * persistent My Files storage (these surface in the conversation Files
     * panel). Null for ordinary uploads.
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
  ],
);

export default skillSandboxFilesTable;
