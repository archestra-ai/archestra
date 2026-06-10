import type { ResourceVisibilityScope } from "@archestra/shared";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { UploadedFileProcessingStatus } from "@/types/kb-uploaded-file";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const kbUploadedFilesTable = pgTable(
  "kb_uploaded_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    organizationId: text("organization_id").notNull(),
    ownerId: text("owner_id"),
    visibility: text("visibility")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("org"),
    teamIds: jsonb("team_ids").$type<string[]>().notNull().default([]),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    contentHash: text("content_hash").notNull(),
    fileData: bytea("file_data"),
    blobStorageProvider: text("blob_storage_provider"),
    blobStorageKey: text("blob_storage_key"),
    processingStatus: text("processing_status")
      .$type<UploadedFileProcessingStatus>()
      .notNull()
      .default("completed"),
    processingError: text("processing_error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("kb_uploaded_files_connector_id_idx").on(table.connectorId),
    index("kb_uploaded_files_organization_id_idx").on(table.organizationId),
    index("kb_uploaded_files_org_content_hash_idx").on(
      table.organizationId,
      table.contentHash,
    ),
    uniqueIndex("kb_uploaded_files_content_hash_uidx").on(
      table.connectorId,
      table.contentHash,
    ),
  ],
);

export default kbUploadedFilesTable;
