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
import foldersTable from "./folder";
import skillSandboxesTable from "./skill-sandbox";
import usersTable from "./user";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Persistent user files ("My Files" / PFS): everything `download_file` and
 * `save_result` produce. Extracted from `skill_sandbox_files` (`kind =
 * 'artifact'`) so ownership is direct instead of derived through the producing
 * sandbox — replay events can only reference `kind = 'upload'` rows, so these
 * files were never part of the sandbox recipe.
 *
 * Ownership:
 *   - `user_id` — the AUTHOR: whoever ran download_file / save_result.
 *   - `folder_id` — where the file lives. A personal folder is visible to its
 *     owner; a project's result folder (`folders.project_id`) is visible to
 *     anyone with access to that project. Both derive from the folder, not a
 *     column here.
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
    /** PFS folder the file sits in; null = root. */
    folderId: uuid("folder_id").references(() => foldersTable.id, {
      onDelete: "set null",
    }),
    /** Conversation the file was produced in, when known (chat Files panel). */
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
    /**
     * Producing sandbox, when one exists — PURE PROVENANCE (which replay
     * recipe made this file). Never used for access or listing decisions.
     * SET NULL so sandboxes stay garbage-collectable. Null for save_result
     * files (no sandbox involved).
     */
    sandboxId: uuid("sandbox_id").references(() => skillSandboxesTable.id, {
      onDelete: "set null",
    }),
    /** Display name (was `original_name ?? basename(path)` in the old table). */
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageProvider: text("storage_provider")
      .$type<SkillSandboxFileStorageProvider>()
      .notNull()
      .default("db"),
    /** Bytes when storage_provider = 'db'; null when object_key is set (check below). */
    data: bytea("data"),
    objectKey: text("object_key"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("files_organization_id_idx").on(table.organizationId),
    index("files_user_id_idx").on(table.userId),
    index("files_folder_id_idx").on(table.folderId),
    index("files_conversation_id_idx").on(table.conversationId),
    // not for queries — lets future sandbox deletes SET NULL without a
    // sequential scan over files.
    index("files_sandbox_id_idx").on(table.sandboxId),
    // exactly one byte location per row: bytea for 'db', object_key for
    // 'filesystem'. A row violating this is unreadable, so reject at write time.
    check(
      "files_storage_payload_chk",
      sql`(
        (${table.storageProvider} = 'db' AND ${table.data} IS NOT NULL AND ${table.objectKey} IS NULL)
        OR (${table.storageProvider} = 'filesystem' AND ${table.objectKey} IS NOT NULL AND ${table.data} IS NULL)
      )`,
    ),
  ],
);

export default filesTable;
