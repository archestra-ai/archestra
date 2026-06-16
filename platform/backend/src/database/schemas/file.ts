import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { SkillSandboxFileStorageProvider } from "@/types/skill-sandbox";
import conversationsTable from "./conversation";
import projectsTable from "./project";
import skillSandboxesTable from "./skill-sandbox";
import usersTable from "./user";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Persistent user files ("My Files" / PFS): everything `download_file` and
 * `save_result` produce.
 *
 * Ownership is direct, no folder indirection:
 *   - `user_id` — the AUTHOR (always set). A file with no `project_id` is the
 *     author's own personal file.
 *   - `project_id` — when set, the file belongs to that PROJECT; access is the
 *     project's membership (not the author). Deleting the project deletes the
 *     file (cascade).
 *
 * Bytes are Postgres-only today (`storage_provider = 'db'`, `data` bytea); the
 * `storage_provider`/`object_key` columns are the seam a future external
 * backend would use (`skills-sandbox/file-storage.ts`).
 */
const filesTable = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** Author — whoever produced the file; their deletion removes it. */
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Owning project; null = the author's own file. Project delete cascades. */
    projectId: uuid("project_id").references(() => projectsTable.id, {
      onDelete: "cascade",
    }),
    /** Conversation the file was produced in, when known (chat Files panel). */
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
    /** Producing sandbox — PURE PROVENANCE; never used for access. */
    sandboxId: uuid("sandbox_id").references(() => skillSandboxesTable.id, {
      onDelete: "set null",
    }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageProvider: text("storage_provider")
      .$type<SkillSandboxFileStorageProvider>()
      .notNull()
      .default("db"),
    /** Bytes when storage_provider = 'db'; null when object_key is set. */
    data: bytea("data"),
    objectKey: text("object_key"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("files_organization_id_idx").on(table.organizationId),
    index("files_user_id_idx").on(table.userId),
    index("files_project_id_idx").on(table.projectId),
    index("files_conversation_id_idx").on(table.conversationId),
    index("files_sandbox_id_idx").on(table.sandboxId),
    // exactly one byte location per row; provider-agnostic so adding an
    // external backend later needs no CHECK migration.
    check(
      "files_storage_payload_chk",
      sql`(
        (${table.storageProvider} =  'db' AND ${table.data} IS NOT NULL AND ${table.objectKey} IS NULL)
        OR (${table.storageProvider} <> 'db' AND ${table.objectKey} IS NOT NULL AND ${table.data} IS NULL)
      )`,
    ),
  ],
);

export default filesTable;
