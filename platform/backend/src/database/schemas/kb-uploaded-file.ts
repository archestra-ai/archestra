import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    contentHash: text("content_hash").notNull(),
    fileData: bytea("file_data").notNull(),
    processingStatus: text("processing_status").notNull().default("completed"),
    processingError: text("processing_error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("kb_uploaded_files_connector_id_idx").on(table.connectorId),
    uniqueIndex("kb_uploaded_files_content_hash_uidx").on(
      table.connectorId,
      table.contentHash,
    ),
  ],
);

export default kbUploadedFilesTable;
