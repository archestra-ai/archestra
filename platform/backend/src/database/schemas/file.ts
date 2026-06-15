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
 * Ownership mirrors the old sandbox-derived semantics exactly:
 *   - `user_id` — the AUTHOR: whoever ran download_file / save_result (was
 *     the producing sandbox's user).
 *   - `folder_id` — where the file lives; a project's result folder links the
 *     file to that project. The folder OWNER's visibility comes from owning
 *     the folder (`skill_sandbox_folders.user_id`), not from a column here —
 *     project folders collect results from every member's chats.
 *
 * Bytes live in `data` (when `storage_provider = 'db'`) or on the filesystem
 * under `object_key` (when `storage_provider = 'filesystem'`), exactly like
 * `skill_sandbox_files` — same router (`skills-sandbox/file-storage.ts`).
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
