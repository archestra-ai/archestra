import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import kbDocumentsTable from "./kb-document";
import kbFilesTable from "./kb-file";

/**
 * Which indexed documents came from which repository file.
 *
 * A file indexed into two knowledge bases produces two documents (one per that
 * base's upload connector, since `kb_documents.connector_id` is 1:1), so this
 * is the link that lets "remove this file from that knowledge base" and
 * "delete this file everywhere" find their targets.
 */
const kbFileDocumentsTable = pgTable(
  "kb_file_document",
  {
    kbFileId: uuid("kb_file_id")
      .notNull()
      .references(() => kbFilesTable.id, { onDelete: "cascade" }),
    kbDocumentId: uuid("kb_document_id")
      .notNull()
      .references(() => kbDocumentsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.kbFileId, table.kbDocumentId] }),
    index("kb_file_document_document_idx").on(table.kbDocumentId),
  ],
);

export default kbFileDocumentsTable;
