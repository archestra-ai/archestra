import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { KnowledgeFileVisibility } from "@/types/knowledge-file";
import type { SkillSandboxFileStorageProvider } from "@/types/skill-sandbox";
import kbDirectoriesTable from "./kb-directory";
import usersTable from "./user";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * A document in the knowledge file repository — the bytes a user uploaded,
 * independent of whether they are indexed into any knowledge base.
 *
 * Deliberately NOT a scope on `files`. That table is user-authored storage
 * whose `user_id` is `ON DELETE CASCADE`, so offboarding an uploader would
 * silently delete an organization's knowledge asset; its per-scope partial
 * unique indexes and CHECK would also all need reworking for a fourth scope.
 * What is worth sharing is the storage LAYER, not the row semantics: the
 * `storage_provider` / `data` / `object_key` triple matches `files` exactly, so
 * `skills-sandbox/file-storage.ts`'s structural `readRowBytes` / `deleteRowBytes`
 * work on these rows unchanged, and an external backend later needs no
 * migration here.
 */
const kbFilesTable = pgTable(
  "kb_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** Null = the repository root. Deleting a directory moves its files here. */
    directoryId: uuid("directory_id").references(() => kbDirectoriesTable.id, {
      onDelete: "set null",
    }),
    /**
     * Authoritative audience for this file. Seeded from its directory at
     * upload and re-appliable in bulk from the directory, but never derived at
     * read time — a file promoted out of a private chat has to be able to stay
     * private regardless of where it was filed.
     */
    visibility: text("visibility")
      .$type<KnowledgeFileVisibility>()
      .notNull()
      .default("org-wide"),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentHash: text("content_hash").notNull(),
    storageProvider: text("storage_provider")
      .$type<SkillSandboxFileStorageProvider>()
      .notNull()
      .default("db"),
    /** Bytes when storage_provider = 'db'; null when object_key is set. */
    data: bytea("data"),
    objectKey: text("object_key"),
    /** Uploader. Nulled rather than cascaded — the org owns the file. */
    uploadedBy: text("uploaded_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("kb_files_organization_id_idx").on(table.organizationId),
    index("kb_files_directory_id_idx").on(table.directoryId),
    // Two partial indexes rather than one three-column index: Postgres treats
    // NULLs as distinct, so a single index would let unlimited same-named files
    // pile up at the root while appearing to forbid duplicates.
    uniqueIndex("kb_files_org_directory_filename_uidx")
      .on(table.organizationId, table.directoryId, table.filename)
      .where(sql`${table.directoryId} IS NOT NULL`),
    uniqueIndex("kb_files_org_root_filename_uidx")
      .on(table.organizationId, table.filename)
      .where(sql`${table.directoryId} IS NULL`),
    // Exactly one byte location per row; provider-agnostic, mirroring `files`.
    check(
      "kb_files_storage_payload_chk",
      sql`(
        (${table.storageProvider} =  'db' AND ${table.data} IS NOT NULL AND ${table.objectKey} IS NULL)
        OR (${table.storageProvider} <> 'db' AND ${table.objectKey} IS NOT NULL AND ${table.data} IS NULL)
      )`,
    ),
  ],
);

export default kbFilesTable;
